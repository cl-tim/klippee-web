import { sql } from "drizzle-orm";
import { physicalPrinters, privatePackages, publicPackages } from "../schema";
import { packages } from "../../src/data";
import { hasBlockingSafetyFindings, scanConfigFiles, scanPublicConfigFiles } from "../../src/safety";
import type { ConfigPackage } from "../../src/types";
import { deleteCanonicalBlobWriteLeaseQuery } from "../blobBudget";
import { loadOwnedCompanionAssets, loadPublicCompanionAssets } from "../companionAssets";
import { drizzleDb, readDb, writeDb, type DrizzleWriteBatch } from "../db";
import { updateAutomaticPublications } from "../packageAutoUpdates";
import { json, readJsonBody, securityHeaders } from "../http";
import {
  deleteDefaultPublicPackageCache,
  listPackageSummaries,
  packageSearchFacets,
  packageSummariesResponse,
  publicPackageCacheKey,
  type PackageFilters,
} from "../packageCatalog";
import {
  buildPublicPackagePublicationStatement,
  buildPublicListingMetadataUpdateStatements,
  createPublicPackagePublishPlan,
  createPublicPackageRowId,
  createPublicPackageSlug,
  parsePublishPackageBody,
} from "../packagePublishing";
import { printerHasPackage, scrubPrinterSecretValueStatements, secretVariableJsonPaths } from "../packageSecrets";
import {
  loadStoredConfigPackage,
  publicPackageResponse,
  storeConfigPackageJson,
  summarizeStoredPackage,
} from "../packageStorage";
import { maxPrivatePackagesPerUser, storageQuotaExceeded } from "../storageLimits";
import { PrinterRepository } from "../repositories/PrinterRepository";
import { PublicPackageRepository } from "../repositories/PublicPackageRepository";
import { PrivatePackageRepository } from "../repositories/PrivatePackageRepository";
import { CompanionAssetRepository, companionAttachmentSourcesPresent } from "../repositories/CompanionAssetRepository";
import { loadRepositoryFiles } from "../repositoryFiles";
import {
  PackageRenderLimitError,
  PackageVariableInputError,
  renderPackageFiles,
  renderValuesForBody,
  safeZipFilename,
  unresolvedTemplateVariables,
} from "../packageRendering";
import { variableSchemaFromFiles } from "../packageVariables";
import { enforceRateLimit } from "../rateLimit";
import type { Env, PublicPackageRow, VariableValues } from "../types";
import { isRecord, nowIso } from "../util";
import {
  hasWarningSafetyFindings,
  parseConfigPackage,
  publicPackageForPublish,
  sanitizePublicPackageVariables,
  validatePackageVariables,
} from "../validation";
import { createZip } from "../zip";
import { requireUser } from "./auth";

function packageRenderLimitResponse(error: PackageRenderLimitError) {
  return json({
    code: "rendered_package_too_large",
    error: `Rendered package exceeds the ${error.limitBytes}-byte limit. Shorten variable values and try again.`,
    limitBytes: error.limitBytes,
  }, { status: 413 });
}

function packageVariableInputResponse(error: PackageVariableInputError) {
  return json({
    code: "invalid_package_variables",
    error: error.message,
  }, { status: 400 });
}

/** Derives the deduplicated scrub paths for a package's secret variables. */
function packageSecretVariableJsonPaths(pkg: Pick<ConfigPackage, "variables">) {
  return secretVariableJsonPaths(
    pkg.variables
      .filter((variable) => variable.secret || variable.type === "secret")
      .map((variable) => variable.name),
  );
}

function appliedVersionChangedResponse(currentAppliedVersionId: string | null) {
  return json({
    code: "applied_version_changed",
    currentAppliedVersionId,
    error: "The printer's applied configuration changed; review it before publishing",
  }, { status: 409 });
}

async function publicPackageSnapshot(env: Env, row: PublicPackageRow) {
  const pkg = await publicPackageResponse(env, row);
  if (!pkg) {
    return pkg;
  }
  return {
    ...pkg,
    tracksAppliedConfiguration: Boolean(row.repository_id && row.printer_id && row.approved_version_id),
  };
}

export async function listPrivatePackages(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const rows = await PrivatePackageRepository.listForUser(readDb(env), user.id);

  const loaded = rows.map((row) => {
    const pkg = summarizeStoredPackage(row.package_json);
    return pkg ? { ...pkg, cloudCreatedAt: row.created_at, cloudUpdatedAt: row.updated_at } : null;
  });

  return json({
    packages: loaded.filter((pkg): pkg is NonNullable<typeof pkg> => pkg !== null),
  });
}

export async function getPrivatePackage(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const row = await PrivatePackageRepository.getOwned(readDb(env), user.id, id);
  if (!row) {
    return json({ error: "Private package not found" }, { status: 404 });
  }

  const pkg = await loadStoredConfigPackage(env, row.package_json);
  if (!pkg) {
    return json({ error: "Stored private package is invalid" }, { status: 422 });
  }
  const companionAssets = await loadOwnedCompanionAssets(env, user.id, pkg.companionAssetIds ?? []);

  return json({
    package: {
      ...pkg,
      companionAssets,
      cloudCreatedAt: row.created_at,
      cloudUpdatedAt: row.updated_at,
    },
  });
}

export async function savePrivatePackage(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const parsedBody = await readJsonBody<{ package?: unknown } | null>(request, 1_024_000, "Package payload is too large");
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const body = parsedBody.value ?? null;
  const pkg = parseConfigPackage(body?.package);
  if (!pkg) {
    return json({ error: "Package must include metadata, variables, warnings, and files" }, { status: 400 });
  }

  const safetyFindings = scanConfigFiles(pkg.files);
  if (hasBlockingSafetyFindings(safetyFindings)) {
    return json({ error: "Safety scan blocked this package", safetyFindings }, { status: 422 });
  }

  const db = writeDb(env);
  const quotaState = await PrivatePackageRepository.getSaveQuota(db, user.id, pkg.id);
  if (!quotaState?.existing_package && (quotaState?.package_count ?? 0) >= maxPrivatePackagesPerUser) {
    return storageQuotaExceeded("private-packages", maxPrivatePackagesPerUser);
  }

  const timestamp = nowIso();
  const attachmentIds = (await CompanionAssetRepository.listOwnedAttachmentIds(db, user.id, pkg.companionAssetIds ?? [])).map(row => row.id);
  const storedPackage = await storeConfigPackageJson(env, user.id, pkg);
  const secretVariablePaths = packageSecretVariableJsonPaths(pkg);
  const writes: DrizzleWriteBatch = [PrivatePackageRepository.upsertQuery(db, {
    id: crypto.randomUUID(), userId: user.id, packageId: pkg.id, name: pkg.name, title: pkg.title,
    packageJson: storedPackage.packageJson, createdAt: timestamp, updatedAt: timestamp,
  }, companionAttachmentSourcesPresent(user.id, attachmentIds))];
  // All scrub chunks participate in the same atomic batch as the insert.
  writes.push(...scrubPrinterSecretValueStatements(db, secretVariablePaths,
    sql`${physicalPrinters.userId} = ${user.id} and ${printerHasPackage(pkg.id)} and exists (
      select 1 from ${privatePackages} where ${privatePackages.userId} = ${user.id} and ${privatePackages.packageId} = ${pkg.id}
        and ${privatePackages.packageJson} = ${storedPackage.packageJson}
    )`, timestamp));
  writes.push(deleteCanonicalBlobWriteLeaseQuery(db, storedPackage.leaseId));
  // D1 batch statements are committed atomically and in order. If a printer
  // was bound before this package save completed, the package insert becomes
  // visible to the following scrub in the same transaction.
  const [stored] = await drizzleDb(db).batch(writes);
  if ((stored.meta.changes ?? 0) < 1) {
    const remaining = await CompanionAssetRepository.listOwnedAttachmentIds(db, user.id, attachmentIds);
    if (remaining.length !== attachmentIds.length) {
      return json({ code: "companion_attachment_conflict", error: "An attached preset was deleted while saving this package. Reload its attachments before retrying." }, { status: 409 });
    }
    return storageQuotaExceeded("private-packages", maxPrivatePackagesPerUser);
  }

  return json({ package: pkg, savedAt: timestamp }, { status: 201 });
}

export async function publishPackage(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const parsedBody = await readJsonBody<unknown>(request, 1_024_000, "Package payload is too large");
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const parsed = parsePublishPackageBody(parsedBody.value);
  if (!parsed.ok) {
    return parsed.response;
  }
  const { acknowledgeSafetyWarnings, expectedAppliedVersionId, packageId, printerId, repositoryId } = parsed;
  const primaryDb = writeDb(env);

  const ownedPackage = await PrivatePackageRepository.getOwned(primaryDb, user.id, packageId);
  if (!ownedPackage) {
    return json({ error: "Private package not found" }, { status: 404 });
  }

  const existingPublication = await PublicPackageRepository.getExistingPublication(primaryDb, user.id, packageId);
  const effectiveRepositoryId = repositoryId ?? existingPublication?.repository_id ?? null;
  const effectivePrinterId = repositoryId ? printerId : existingPublication?.printer_id ?? null;
  if (effectiveRepositoryId && !effectivePrinterId) {
    return json({ error: "Select the printer whose applied configuration this listing should follow" }, { status: 409 });
  }
  if (effectiveRepositoryId && !expectedAppliedVersionId) {
    return json({ error: "Expected applied version id is required for a linked public configuration" }, { status: 400 });
  }
  if (!effectiveRepositoryId && expectedAppliedVersionId) {
    return json({ error: "Expected applied version id requires a linked public configuration" }, { status: 400 });
  }

  let ownedParsedPackage = await loadStoredConfigPackage(env, ownedPackage.package_json);
  let approvedVersionId: string | null = null;
  if (!ownedParsedPackage) {
    return json({ error: "Stored private package is invalid" }, { status: 422 });
  }
  if (effectiveRepositoryId && effectivePrinterId) {
    const applied = await PrinterRepository.getAppliedVersion(primaryDb, user.id, effectivePrinterId, effectiveRepositoryId);
    if (!applied || applied.id !== expectedAppliedVersionId) {
      return appliedVersionChangedResponse(applied?.id ?? null);
    }
    const files = await loadRepositoryFiles(env, applied.files_json);
    if (!files) {
      return json({ error: "Stored applied configuration is invalid" }, { status: 422 });
    }
    ownedParsedPackage = { ...ownedParsedPackage, files };
    approvedVersionId = applied.id;
  }

  const publishedPackage = publicPackageForPublish(ownedParsedPackage);
  const pkg = {
    ...publishedPackage,
    // Live placeholders are authoritative for linked and unlinked packages.
    // Metadata can enrich them, but cannot hide an undeclared substitution.
    variables: sanitizePublicPackageVariables(
      variableSchemaFromFiles(publishedPackage.files, publishedPackage.variables),
    ),
  };
  const safetyFindings = scanPublicConfigFiles(pkg.files);
  if (hasBlockingSafetyFindings(safetyFindings)) {
    return json({ error: "Safety scan blocked publishing this package", safetyFindings }, { status: 422 });
  }
  if (hasWarningSafetyFindings(safetyFindings) && !acknowledgeSafetyWarnings) {
    return json(
      {
        error: "Safety warnings must be acknowledged before publishing this package",
        safetyFindings,
      },
      { status: 409 },
    );
  }

  const timestamp = nowIso();
  const rowId = existingPublication?.id ?? await createPublicPackageRowId(user.id, packageId);
  const slug = existingPublication?.slug ?? await createPublicPackageSlug(pkg, user.id);
  const plan = createPublicPackagePublishPlan({
    createdAt: existingPublication?.created_at ?? timestamp,
    origin: env.APP_ORIGIN,
    pkg,
    rowId,
    slug,
    timestamp,
    userId: user.id,
  });
  const storedPackage = await storeConfigPackageJson(env, user.id, pkg);
  const linkedPublication = Boolean(effectiveRepositoryId && effectivePrinterId && approvedVersionId);
  const publicationStatement = buildPublicPackagePublicationStatement(primaryDb, {
    approvedVersionId,
    hasExistingPublication: Boolean(existingPublication),
    linkedPublication,
    packageJson: storedPackage.packageJson,
    printerId: effectivePrinterId,
    repositoryId: effectiveRepositoryId,
    row: plan.row,
    sourcePackageId: packageId,
    userId: user.id,
  });
  const secretVariablePaths = packageSecretVariableJsonPaths(pkg);
  const publicationWrites: DrizzleWriteBatch = [publicationStatement];
  publicationWrites.push(...scrubPrinterSecretValueStatements(primaryDb, secretVariablePaths,
    sql`${printerHasPackage(slug)} and exists (select 1 from ${publicPackages}
      where ${publicPackages.slug} = ${slug} and ${publicPackages.userId} = ${user.id}
        and ${publicPackages.sourcePackageId} = ${packageId} and ${publicPackages.packageJson} = ${storedPackage.packageJson})`, timestamp));
  publicationWrites.push(deleteCanonicalBlobWriteLeaseQuery(primaryDb, storedPackage.leaseId));
  // Reclassification and cleanup share the publication transaction. The
  // exact stored-package guard also makes cleanup safe if the guarded publish
  // loses a race: values are removed only when the currently public snapshot
  // itself declares those names secret.
  const [publicationWrite] = await drizzleDb(primaryDb).batch(publicationWrites);
  if ((publicationWrite.meta.changes ?? 0) < 1) {
    // linkedPublication implies both ids are set; the extra checks narrow types.
    if (linkedPublication && effectivePrinterId && effectiveRepositoryId) {
      const currentApplied = await PrinterRepository.getAppliedVersion(primaryDb, user.id, effectivePrinterId, effectiveRepositoryId);
      if (currentApplied?.id !== approvedVersionId) {
        return appliedVersionChangedResponse(currentApplied?.id ?? null);
      }
    }
    if (!existingPublication) {
      return json({
        code: "publication_conflict",
        error: "This package was published by another request; reload its public listing before continuing",
      }, { status: 409 });
    }
    return appliedVersionChangedResponse(null);
  }
  await deleteDefaultPublicPackageCache(env);

  return json({
    ...plan.response,
    package: {
      ...plan.response.package,
      tracksAppliedConfiguration: Boolean(approvedVersionId),
    },
  }, { status: 201 });
}

export async function getPublicPackageApprovalStatus(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const row = await PublicPackageRepository.getApprovalStatus(writeDb(env), user.id, id);
  if (!row) {
    return json({ error: "Public listing not found" }, { status: 404 });
  }

  const linked = Boolean(row.printer_id && row.repository_id);
  return json({
    status: {
      approvedVersionId: row.approved_version_id,
      autoUpdateEnabled: linked && row.auto_update_enabled === 1,
      autoUpdateError: row.auto_update_error,
      currentAppliedVersionId: row.current_applied_version_id,
      hasUnpublishedAppliedVersion: Boolean(
        linked && row.current_applied_version_id && row.current_applied_version_id !== row.approved_version_id
      ),
      linked,
    },
  });
}

export async function setPublicPackageAutoUpdate(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const parsed = await readJsonBody<unknown>(request, 4_096);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.value) || typeof parsed.value.enabled !== "boolean") {
    return json({ error: "Automatic updates require an enabled boolean" }, { status: 400 });
  }
  const db = writeDb(env);
  const row = await PublicPackageRepository.getAutoUpdateContext(db, user.id, id);
  if (!row) return json({ error: "Public listing not found" }, { status: 404 });
  const enabled = parsed.value.enabled;
  const settingUpdatedAt = nowIso();
  const updated = await PublicPackageRepository.setAutoUpdate(db, {
    id: row.id, userId: user.id, printerId: row.printer_id, repositoryId: row.repository_id, enabled, timestamp: settingUpdatedAt,
  });
  if ((updated.meta.changes ?? 0) !== 1) {
    return json({ error: "Automatic updates require a listing linked to your printer; reload the listing" }, { status: 409 });
  }
  if (enabled && row.printer_id && row.repository_id) {
    try {
      await updateAutomaticPublications(env, user.id, row.repository_id, row.printer_id, row.id);
    } catch {
      await PublicPackageRepository.recordSettingFailure(db, {
        id: row.id, userId: user.id, printerId: row.printer_id, repositoryId: row.repository_id, timestamp: settingUpdatedAt,
        error: "Automatic update to Shared Configs failed. Retry or republish manually.",
      });
    }
  }
  return getPublicPackageApprovalStatus(request, env, id);
}

export async function updatePublicPackageListing(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const parsedBody = await readJsonBody<unknown>(request, 32_000, "Listing details are too large");
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const listing = parsePublicListingMetadata(parsedBody.value);
  if (!listing) {
    return json({ error: "Listing must include a title, description, printer, hardware, and tags" }, { status: 400 });
  }

  // Keep the read-modify-write sequence on the primary. A replica can lag an
  // owner approval and must not supply older package bytes for this mutation.
  const primaryDb = writeDb(env);
  const row = await PublicPackageRepository.getOwnedForEdit(primaryDb, user.id, id);
  if (!row) {
    return json({ error: "Public listing not found" }, { status: 404 });
  }

  const storedPackage = await loadStoredConfigPackage(env, row.package_json);
  if (!storedPackage) {
    return json({ error: "Stored public package is invalid" }, { status: 422 });
  }

  const updatedPackage = {
    ...storedPackage,
    description: listing.description,
    hardware: listing.hardware,
    printer: listing.printer,
    tags: Array.from(new Set(["public", ...listing.tags.filter((tag) => tag !== "private" && tag !== "public")])),
    title: listing.title,
    variables: sanitizePublicPackageVariables(storedPackage.variables),
  };
  const facets = packageSearchFacets(updatedPackage);
  const timestamp = nowIso();
  const storedPublicPackage = await storeConfigPackageJson(env, user.id, updatedPackage);
  const privateRow = await PrivatePackageRepository.getOwned(primaryDb, user.id, row.source_package_id);
  const privatePackage = privateRow ? await loadStoredConfigPackage(env, privateRow.package_json) : null;
  let storedPrivatePackage: Awaited<ReturnType<typeof storeConfigPackageJson>> | null = null;
  let updatedPrivatePackage: ConfigPackage | null = null;
  if (privatePackage) {
    updatedPrivatePackage = {
      ...privatePackage,
      description: listing.description,
      hardware: listing.hardware,
      printer: listing.printer,
      tags: Array.from(new Set(["private", ...listing.tags.filter((tag) => tag !== "private" && tag !== "public")])),
      title: listing.title,
    };
    storedPrivatePackage = await storeConfigPackageJson(env, user.id, updatedPrivatePackage);
  }

  const writes = buildPublicListingMetadataUpdateStatements(primaryDb, {
    expectedPrivate: privateRow
      ? { packageJson: privateRow.package_json, updatedAt: privateRow.updated_at }
      : null,
    expectedPublic: {
      approvedVersionId: row.approved_version_id ?? null,
      id: row.id,
      packageJson: row.package_json,
      printerId: row.printer_id ?? null,
      repositoryId: row.repository_id ?? null,
      updatedAt: row.updated_at,
    },
    privatePackageJson: storedPrivatePackage?.packageJson ?? null,
    privateTitle: updatedPrivatePackage?.title ?? listing.title,
    publicPackageJson: storedPublicPackage.packageJson,
    publicSearch: facets,
    sourcePackageId: row.source_package_id,
    timestamp,
    title: updatedPackage.title,
    userId: user.id,
  });
  writes.push(deleteCanonicalBlobWriteLeaseQuery(primaryDb, storedPublicPackage.leaseId));
  if (storedPrivatePackage) {
    writes.push(deleteCanonicalBlobWriteLeaseQuery(primaryDb, storedPrivatePackage.leaseId));
  }
  if (env.LOCAL_AUTH_BYPASS === "1" && env.PUBLIC_LISTING_PATCH_TEST_HOOK) {
    const hookResponse = await env.PUBLIC_LISTING_PATCH_TEST_HOOK.fetch(
      "https://public-listing-patch.test/before-write",
      { method: "POST" },
    );
    if (!hookResponse.ok) {
      throw new Error("Public listing PATCH test hook failed");
    }
  }
  const results = await drizzleDb(primaryDb).batch(writes);
  if ((results[0]?.meta.changes ?? 0) < 1) {
    return json({
      code: "public_listing_conflict",
      error: "The public listing or its source package changed while you were editing its details; reload and review the current version",
    }, { status: 409 });
  }

  await deleteDefaultPublicPackageCache(env);

  const publicPackage = await publicPackageSnapshot(env, {
    ...row,
    package_json: storedPublicPackage.packageJson,
    updated_at: timestamp,
  });
  if (!publicPackage) {
    return json({ error: "Applied public configuration is invalid" }, { status: 422 });
  }
  return json({
    package: publicPackage,
    shareUrl: `${env.APP_ORIGIN}/packages/${row.slug}`,
  });
}

function parsePublicListingMetadata(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const title = cleanListingText(value.title, 160);
  const description = cleanListingText(value.description, 2_000, true);
  const printer = cleanListingText(value.printer, 160, true);
  const hardware = cleanListingValues(value.hardware, 24, 80);
  const tags = cleanListingValues(value.tags, 24, 64);
  if (!title || description === null || printer === null || !hardware || !tags) {
    return null;
  }
  return { description, hardware, printer, tags, title };
}

function cleanListingText(value: unknown, maximumLength: number, allowEmpty = false) {
  if (typeof value !== "string") {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if ((!cleaned && !allowEmpty) || cleaned.length > maximumLength) {
    return null;
  }
  return cleaned;
}

function cleanListingValues(value: unknown, maximumItems: number, maximumLength: number) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return null;
  }
  const values = value.map((item) => cleanListingText(item, maximumLength)).filter(Boolean) as string[];
  if (values.length !== value.length) {
    return null;
  }
  return Array.from(new Set(values));
}

export async function getPublicPackage(env: Env, id: string) {
  let row: (PublicPackageRow & { user_id: string }) | null;
  try {
    row = await PublicPackageRepository.getPublic(readDb(env), id);
  } catch {
    return null;
  }
  if (!row) {
    return null;
  }
  const pkg = await publicPackageSnapshot(env, row);
  if (!pkg) {
    return null;
  }
  return {
    ...pkg,
    companionAssets: await loadPublicCompanionAssets(env, row.user_id, pkg.companionAssetIds ?? [], env.APP_ORIGIN),
  };
}

export async function findPackage(env: Env, id: string) {
  return packages.find((candidate) => candidate.id === id || candidate.name === id) ?? await getPublicPackage(env, id);
}

export async function listPackages(env: Env, filters: PackageFilters = {}, request?: Request) {
  const cacheKey = request && !filters.printer && !filters.q && !filters.tag
    ? publicPackageCacheKey(request, env.APP_ORIGIN)
    : null;
  if (cacheKey && typeof caches !== "undefined") {
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("x-klippee-cache", "HIT");
        return new Response(cached.body, {
          headers,
          status: cached.status,
          statusText: cached.statusText,
        });
      }
    } catch {
      // Cache reads are opportunistic; fall through to D1.
    }
  }

  const response = packageSummariesResponse(await listPackageSummaries(env, packages, filters));
  if (cacheKey && typeof caches !== "undefined") {
    try {
      await caches.default.put(cacheKey, response.clone());
    } catch {
      // Edge cache writes are opportunistic.
    }
  }
  return response;
}

export async function getPackage(env: Env, id: string) {
  const pkg = await findPackage(env, id);
  if (!pkg) {
    return json({ error: "Package not found" }, { status: 404 });
  }

  return json({ package: pkg });
}

export async function renderPackagePreview(request: Request, env: Env, id: string) {
  const limited = await enforceRateLimit(
    env.PACKAGE_RATE_LIMITER,
    request,
    "pkg-preview",
    "Package render limit reached. Try again shortly.",
  );
  if (limited) {
    return limited;
  }

  const pkg = await findPackage(env, id);
  if (!pkg) {
    return json({ error: "Package not found" }, { status: 404 });
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;

  let values: VariableValues;
  try {
    values = await renderValuesForBody(request, env, pkg, body, { allowSecrets: false });
  } catch (error) {
    if (error instanceof PackageVariableInputError) {
      return packageVariableInputResponse(error);
    }
    throw error;
  }
  const errors = validatePackageVariables(pkg, values);
  let renderedFiles: ConfigPackage["files"];
  try {
    renderedFiles = renderPackageFiles(pkg.files, values);
  } catch (error) {
    if (error instanceof PackageRenderLimitError) {
      return packageRenderLimitResponse(error);
    }
    throw error;
  }
  const files = renderedFiles.map((file) => {
    return {
      content: file.content,
      path: file.path,
      role: file.role,
      unresolvedVariables: unresolvedTemplateVariables(file.content),
    };
  });
  const unresolvedVariables = Array.from(new Set(files.flatMap((file) => file.unresolvedVariables)));

  return json({
    errors,
    files,
    ok: Object.keys(errors).length === 0 && unresolvedVariables.length === 0,
    package: {
      id: pkg.id,
      name: pkg.name,
      publicSlug: pkg.publicSlug,
      sourcePackageId: pkg.sourcePackageId,
      title: pkg.title,
      version: pkg.version,
    },
    unresolvedVariables,
    warnings: pkg.warnings,
  });
}

export async function downloadPackageZip(request: Request, env: Env, id: string) {
  const limited = await enforceRateLimit(
    env.PACKAGE_RATE_LIMITER,
    request,
    "pkg-download",
    "Package download limit reached. Try again shortly.",
  );
  if (limited) {
    return limited;
  }

  const pkg = await findPackage(env, id);
  if (!pkg) {
    return json({ error: "Package not found" }, { status: 404 });
  }

  let values: VariableValues = {};
  if (request.method === "GET") {
    if (pkg.variables.some((variable) => (variable.secret || variable.type === "secret") && variable.required)) {
      return json({ error: "Secret package variables require POST rendering" }, { status: 400 });
    }

    const url = new URL(request.url);
    values = Object.fromEntries(
      pkg.variables
        .filter((variable) => !variable.secret && variable.type !== "secret")
        .map((variable) => [variable.name, url.searchParams.get(variable.name) ?? undefined]),
    );
  } else {
    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }
    const body = parsedBody.value;
    try {
      values = await renderValuesForBody(request, env, pkg, body, { allowSecrets: true });
    } catch (error) {
      if (error instanceof PackageVariableInputError) {
        return packageVariableInputResponse(error);
      }
      throw error;
    }
  }
  const errors = validatePackageVariables(pkg, values);
  let renderedFiles: ConfigPackage["files"];
  try {
    renderedFiles = renderPackageFiles(pkg.files, values);
  } catch (error) {
    if (error instanceof PackageRenderLimitError) {
      return packageRenderLimitResponse(error);
    }
    throw error;
  }
  const unresolvedVariables = Array.from(
    new Set(renderedFiles.flatMap((file) => unresolvedTemplateVariables(file.content))),
  );

  if (Object.keys(errors).length > 0 || unresolvedVariables.length > 0) {
    return json(
      {
        errors,
        error: "Package variables are incomplete",
        unresolvedVariables,
      },
      { status: 422 },
    );
  }

  const summary = {
    files: renderedFiles.map((file) => ({
      path: file.path,
      rendered: file.content !== pkg.files.find((source) => source.path === file.path)?.content,
      role: file.role,
    })),
    package: pkg.name,
    renderedAt: nowIso(),
    variables: pkg.variables.map((variable) => ({
      name: variable.name,
      secret: variable.secret || variable.type === "secret",
      supplied: Boolean(
        Object.prototype.hasOwnProperty.call(values, variable.name) && values[variable.name],
      ),
    })),
    version: pkg.version,
    warnings: pkg.warnings,
  };
  const zip = createZip([
    {
      content: JSON.stringify(summary, null, 2),
      path: "klippee-render-summary.json",
    },
    ...renderedFiles.map((file) => ({ content: file.content, path: file.path })),
  ]);
  return new Response(zip, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${safeZipFilename(`${pkg.name}-${pkg.version}`)}.zip"`,
      "content-type": "application/zip",
      "x-klippee-artifact-storage": "skipped",
      "x-klippee-artifact-storage-reason": "ephemeral-download",
      ...securityHeaders(),
    },
  });
}
