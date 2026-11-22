import { readDb, writeDb } from "../db";
import { tryUpdateAutomaticPublications } from "../packageAutoUpdates";
import {
  preserveCapturedVariableTemplates,
  unprotectedCapturedVariableNames,
} from "../captureVariables";
import { unsafeWorkspaceImportReason } from "../../src/packageBuilder";
import { hasBlockingSafetyFindings, scanConfigFiles } from "../../src/safety";
import { desiredConfigurationDescriptor, loadDesiredConfiguration } from "../desiredConfiguration";
import { json, parseBearerToken, readJsonBody, securityHeaders } from "../http";
import {
  parsePrinterPackageIds,
  secretVariableNamesForUserPackages,
} from "../packageSecrets";
import {
  printerResponse,
  sanitizeVariableValuesForStorage,
} from "../printerShared";
import { loadRepositoryFiles, repositoryFilesRevision } from "../repositoryFiles";
import { RepositoryRepository } from "../repositories/RepositoryRepository";
import { PrinterRepository } from "../repositories/PrinterRepository";
import { SyncTokenRepository } from "../repositories/SyncTokenRepository";
import { createRepositoryVersionFromFiles } from "../repositoryVersions";
import {
  maxRepositoryVersions,
  storageQuotaExceeded,
  syncTokenActivityDebounceSeconds,
} from "../storageLimits";
import { buildSyncSnapshotShellScript, buildSyncStatusText } from "../syncResponses";
import type { D1Client, Env, RepositoryVersionRow, StoredConfigFile, VariableValues } from "../types";
import { hashToken, nowIso, parseJsonFallback } from "../util";
import {
  describeInvalidFiles,
  parseFiles,
  parseHostInfo,
  parseRepositoryVersionMessage,
} from "../validation";

function configFilesMatch(
  left: Array<{ content: string; path: string }>,
  right: Array<{ content: string; path: string }>,
) {
  if (left.length !== right.length) {
    return false;
  }
  const byPath = (a: { path: string }, b: { path: string }) => (
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  const sortedLeft = left.slice().sort(byPath);
  const sortedRight = right.slice().sort(byPath);
  return sortedLeft.every((file, index) => (
    file.path === sortedRight[index].path && file.content === sortedRight[index].content
  ));
}

async function markPrinterAppliedVersion(
  env: Env,
  repositoryId: string,
  userId: string,
  printerId: string | null | undefined,
  versionId: string | null,
  versionNumber: number,
) {
  if (!printerId) {
    return true;
  }
  const timestamp = nowIso();
  const applied = await PrinterRepository.markAppliedVersion(writeDb(env), {
    repositoryId, userId, printerId, versionId, versionNumber, timestamp,
  });
  const marked = (applied.meta.changes ?? 0) === 1;
  if (marked) await tryUpdateAutomaticPublications(env, userId, repositoryId, printerId);
  return marked;
}

async function markPrinterLatestVersion(
  env: Env,
  repositoryId: string,
  userId: string,
  printerId: string | null | undefined,
  versionNumber: number,
) {
  if (!printerId) {
    return;
  }
  await PrinterRepository.markLatestVersion(writeDb(env), {
    repositoryId, userId, printerId, versionNumber, timestamp: nowIso(),
  });
}

async function clearRepositoryPending(env: Env, repositoryId: string, expectedFilesJson: string) {
  return RepositoryRepository.clearPending(writeDb(env), repositoryId, expectedFilesJson);
}

function configurationConflict(
  baseRevision: string | null,
  current: Awaited<ReturnType<typeof loadDesiredConfiguration>>,
) {
  return json({
    baseline: { revision: baseRevision },
    code: "desired_configuration_conflict",
    current: current && current !== "invalid" ? desiredConfigurationDescriptor(current) : null,
    error: "Desired configuration changed since this workspace synchronized",
  }, { status: 409 });
}

function appliedVersionConflict() {
  return json({
    code: "applied_version_conflict",
    error: "The repository version or printer binding changed before it could be marked applied; synchronize again",
  }, { status: 409 });
}

function invalidStoredConfiguration() {
  return json({ error: "Stored desired configuration is invalid" }, { status: 422 });
}

async function preservePrinterVariableTemplates(
  env: Env,
  db: D1Client,
  repositoryId: string,
  userId: string,
  printerId: string | null | undefined,
  files: StoredConfigFile[],
  synchronizedTemplateFiles: StoredConfigFile[] | null,
  rejectOnlyTemplateFiles: StoredConfigFile[] | null,
) {
  const printer = printerId
    ? await PrinterRepository.getCaptureContext(db, printerId, repositoryId, userId)
    : null;
  const secretVariableNames = printer
    ? await secretVariableNamesForUserPackages(
      env,
      userId,
      parsePrinterPackageIds(printer.package_ids_json),
      db,
    )
    : new Set<string>();
  const values = printer
    ? sanitizeVariableValuesForStorage(
      parseJsonFallback(printer.variable_values_json, {} as Record<string, unknown>),
      secretVariableNames,
    )
    : {} as VariableValues;
  if (synchronizedTemplateFiles) {
    // The exact desired baseline is the complete authority. Falling through to
    // an older applied template could resurrect a variable that the desired
    // revision intentionally replaced with a literal.
    const preserved = preserveCapturedVariableTemplates(files, synchronizedTemplateFiles, values);
    return {
      files: preserved,
      unprotectedVariableNames: unprotectedCapturedVariableNames(
        preserved,
        synchronizedTemplateFiles,
        values,
      ),
    };
  }

  let preserved = files;
  let unprotectedVariableNames: string[] = [];

  if (printer && printer.applied_version_id > 0) {
    const applied = await RepositoryRepository.getVersionByNumber(db, repositoryId, printer.applied_version_id);
    const appliedTemplateFiles = applied ? await loadRepositoryFiles(env, applied.files_json) : null;
    if (appliedTemplateFiles) {
      preserved = preserveCapturedVariableTemplates(preserved, appliedTemplateFiles, values);
      unprotectedVariableNames = unprotectedCapturedVariableNames(
        preserved,
        appliedTemplateFiles,
        values,
      );
      return { files: preserved, unprotectedVariableNames };
    }
  }

  if (rejectOnlyTemplateFiles) {
    // An unapplied desired snapshot is not proof of what is installed, so it
    // must never be used to rewrite a capture. It is still a safe rejection
    // boundary: requiring every desired marker to remain in its authoritative
    // location prevents a first capture from flattening those declarations.
    unprotectedVariableNames = unprotectedCapturedVariableNames(
      files,
      rejectOnlyTemplateFiles,
      values,
      { protectAllPlaceholders: true },
    );
  }
  return { files: preserved, unprotectedVariableNames };
}

type CaptureValidationErrors = {
  emptyFiles: string;
  invalidFiles: (files: unknown) => string;
  rejectedPaths: string;
  safetyBlocked: string;
  sidecarRequired: string;
};

/**
 * Shared capture-validation pipeline for printer/desktop-reported config
 * files (`push` and `applied`): parse the raw file list, reject unsafe
 * workspace paths, restore captured variable templates, require a template
 * sidecar when a host-local value cannot be safely converted back, run the
 * blocking safety scan, and compute the resulting revision. The two callers
 * differ only in their error strings and in how they derive the template
 * authorities, so those arrive as arguments.
 */
async function validateAndPreserveCapture(
  env: Env,
  db: D1Client,
  args: {
    errors: CaptureValidationErrors;
    files: unknown;
    printerId: string | null | undefined;
    rejectOnlyTemplateFiles: StoredConfigFile[] | null;
    repositoryId: string;
    synchronizedTemplateFiles: StoredConfigFile[] | null;
    userId: string;
  },
): Promise<
  { files: StoredConfigFile[]; ok: true; revision: string }
  | { ok: false; response: Response }
> {
  const parsedFiles = parseFiles(args.files);
  if (!parsedFiles) {
    return { ok: false, response: json({ error: args.errors.invalidFiles(args.files) }, { status: 400 }) };
  }
  if (parsedFiles.length === 0) {
    return { ok: false, response: json({ error: args.errors.emptyFiles }, { status: 400 }) };
  }
  const rejectedPaths = parsedFiles
    .filter((file) => unsafeWorkspaceImportReason(file.path) !== null)
    .map((file) => file.path);
  if (rejectedPaths.length > 0) {
    return {
      ok: false,
      response: json({ error: args.errors.rejectedPaths, rejectedPaths }, { status: 422 }),
    };
  }
  const preserved = await preservePrinterVariableTemplates(
    env,
    db,
    args.repositoryId,
    args.userId,
    args.printerId,
    parsedFiles,
    args.synchronizedTemplateFiles,
    args.rejectOnlyTemplateFiles,
  );
  if (preserved.unprotectedVariableNames.length > 0) {
    return {
      ok: false,
      response: json({
        code: "variable_template_sidecar_required",
        error: args.errors.sidecarRequired,
        variables: preserved.unprotectedVariableNames,
      }, { status: 422 }),
    };
  }
  const files = preserved.files;
  const safetyFindings = scanConfigFiles(files);
  if (hasBlockingSafetyFindings(safetyFindings)) {
    return {
      ok: false,
      response: json({ error: args.errors.safetyBlocked, safetyFindings }, { status: 422 }),
    };
  }
  return { files, ok: true, revision: await repositoryFilesRevision(files) };
}

export async function requireSyncToken(request: Request, env: Env, repositoryId: string, requiredScope: string) {
  const token = parseBearerToken(request);
  if (token === null) {
    return { response: json({ error: "Sync token required" }, { status: 401 }), repo: null };
  }

  const tokenHash = await hashToken(token, env.SESSION_SECRET);
  const db = writeDb(env);
  const row = await SyncTokenRepository.getAuthenticationContext(db, tokenHash, repositoryId);

  if (!row || (row.expires_at && row.expires_at <= nowIso())) {
    return { response: json({ error: "Invalid sync token" }, { status: 401 }), repo: null };
  }

  const scopes = JSON.parse(row.scopes_json) as string[];
  if (!scopes.includes(requiredScope)) {
    return { response: json({ error: "Sync token scope denied" }, { status: 403 }), repo: null };
  }

  const activityTimestamp = nowIso();
  const activityCutoff = new Date(
    Date.parse(activityTimestamp) - syncTokenActivityDebounceSeconds * 1_000,
  ).toISOString();
  if (!row.last_used_at || row.last_used_at <= activityCutoff) {
    await SyncTokenRepository.recordActivity(db, row.id, activityTimestamp, activityCutoff);
  }

  return {
    clientMode: scopes.includes("client:desktop") || row.token_name.toLowerCase().endsWith(" desktop sync token")
      ? "desktop" as const
      : "printer" as const,
    response: null,
    repo: {
      created_at: row.created_at,
      id: row.repository_id,
      latest_version_id: row.latest_version_id,
      name: row.name,
      title: row.title,
      updated_at: row.updated_at,
    },
    printerId: row.printer_id,
    tokenId: row.id,
    userId: row.user_id,
  };
}

export async function getSyncTargetVersion(
  env: Env,
  repositoryId: string,
  userId?: string | null,
  printerId?: string | null,
  db: D1Client = readDb(env),
) {
  const printer = printerId && userId
    ? await PrinterRepository.getSyncTarget(db, printerId, repositoryId, userId)
    : null;
  const version = await RepositoryRepository.getLatestVersionWithFiles(db, repositoryId);

  return { printer, version };
}

export async function syncPullRepository(request: Request, env: Env, repositoryId: string) {
  const { printerId, response, repo, userId } = await requireSyncToken(request, env, repositoryId, "repo:read");
  if (response) {
    return response;
  }

  const db = writeDb(env);
  const [{ printer }, desired] = await Promise.all([
    getSyncTargetVersion(env, repositoryId, userId, printerId, db),
    loadDesiredConfiguration(env, repositoryId, db),
  ]);
  if (desired === "invalid") {
    return invalidStoredConfiguration();
  }

  const secretVariableNames = printer
    ? await secretVariableNamesForUserPackages(
      env,
      userId,
      parsePrinterPackageIds(printer.package_ids_json),
      db,
    )
    : new Set<string>();

  return json({
    desired: desired ? desiredConfigurationDescriptor(desired) : null,
    printer: printer ? printerResponse(printer, secretVariableNames) : null,
    repository: repo,
    version: desired
      ? {
          ...desired.version,
          files: desired.files,
          revision: desired.revision,
        }
      : null,
  });
}

export async function syncStatusText(request: Request, env: Env, repositoryId: string) {
  const { printerId, response, repo, userId } = await requireSyncToken(request, env, repositoryId, "repo:read");
  if (response) {
    return response;
  }

  const [{ printer }, desired] = await Promise.all([
    getSyncTargetVersion(env, repositoryId, userId, printerId),
    loadDesiredConfiguration(env, repositoryId),
  ]);
  if (desired === "invalid") {
    return invalidStoredConfiguration();
  }

  return new Response(buildSyncStatusText({ desired, printer, repository: repo, repositoryId }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      ...securityHeaders(),
    },
  });
}

export async function syncSnapshotShell(request: Request, env: Env, repositoryId: string) {
  const { printerId, response, userId } = await requireSyncToken(request, env, repositoryId, "repo:read");
  if (response) {
    return response;
  }

  const [{ printer }, desired] = await Promise.all([
    getSyncTargetVersion(env, repositoryId, userId, printerId),
    loadDesiredConfiguration(env, repositoryId),
  ]);
  if (desired === "invalid") {
    return invalidStoredConfiguration();
  }
  if (!desired) {
    return json({ error: "No repository versions found" }, { status: 404 });
  }

  return new Response(buildSyncSnapshotShellScript({
    files: desired.files,
    printer,
    repositoryId,
    revision: desired.revision,
    version: desired.version,
  }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-sh; charset=utf-8",
      ...securityHeaders(),
    },
  });
}

export async function syncPushRepository(request: Request, env: Env, repositoryId: string) {
  const { clientMode: tokenClientMode, printerId, response, repo, userId } = await requireSyncToken(request, env, repositoryId, "repo:write");
  if (response) {
    return response;
  }

  const parsedBody = await readJsonBody<{
    baseRevision?: string;
    baseVersionNumber?: number;
    clientMode?: string;
    files?: unknown;
    message?: string;
    protocolVersion?: number;
  } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;
  const desktopClient = tokenClientMode === "desktop";
  // Capture normalization participates in this write operation. Keep its
  // printer values, applied pointer, and desired snapshot on a primary D1
  // session so a just-saved value cannot be flattened by a stale replica read.
  const db = writeDb(env);
  const parsedMessage = parseRepositoryVersionMessage(body?.message);
  if (!parsedMessage.ok) {
    return json({ error: parsedMessage.error }, { status: 400 });
  }
  const desired = await loadDesiredConfiguration(env, repositoryId, db);
  if (desired === "invalid") {
    return invalidStoredConfiguration();
  }
  const baseRevision = typeof body?.baseRevision === "string" ? body.baseRevision : null;
  // A desired snapshot is a capture template authority only when this client
  // proves it synchronized that exact revision. This rescues variables first
  // introduced in a pending/browser draft without allowing an old printer to
  // claim that an unapplied draft is its current state.
  const synchronizedTemplateFiles = desired && baseRevision === desired.revision
    ? desired.files
    : null;
  const validatedCapture = await validateAndPreserveCapture(env, db, {
    errors: {
      emptyFiles: "Push requires at least one config file",
      invalidFiles: describeInvalidFiles,
      rejectedPaths: "Push contains non-config or sensitive files",
      safetyBlocked: "Safety scan blocked this configuration",
      sidecarRequired: "Capture stopped because host-local variable values could not be safely converted back to placeholders; apply the desired configuration with the current Klippee client and retry",
    },
    files: body?.files,
    printerId,
    rejectOnlyTemplateFiles: desired?.files ?? null,
    repositoryId,
    synchronizedTemplateFiles,
    userId,
  });
  if (!validatedCapture.ok) {
    return validatedCapture.response;
  }
  const files = validatedCapture.files;
  const incomingRevision = validatedCapture.revision;

  // Idempotent retries are safe even when the caller's baseline is old.
  if (desired && configFilesMatch(files, desired.files)) {
    if (!desktopClient && !desired.pending) {
      const markedApplied = await markPrinterAppliedVersion(
        env,
        repositoryId,
        userId,
        printerId,
        desired.version.id,
        desired.version.version_number,
      );
      if (!markedApplied) {
        return appliedVersionConflict();
      }
    }
    if (desktopClient || !desired.pending) {
      return json({
        desired: desiredConfigurationDescriptor(desired),
        unchanged: true,
        version: {
          ...desired.version,
          files: desired.files,
          revision: desired.revision,
        },
      });
    }
  }

  if (desktopClient) {
    if (desired && body?.protocolVersion === 2 && !baseRevision) {
      return json({
        code: "workspace_baseline_required",
        current: desiredConfigurationDescriptor(desired),
        error: "Desktop capture requires a synchronized workspace baseline; run klippee apply first",
      }, { status: 409 });
    }
    if (baseRevision && desired?.revision !== baseRevision) {
      return configurationConflict(baseRevision, desired);
    }
    // Desktop capture replaces the same mutable, size-bounded draft as the web
    // editor. Keep it inline so repeated captures do not strand immutable R2
    // blobs before the printer materializes a retained version.
    const filesJson = JSON.stringify(files);
    const timestamp = nowIso();
    const staged = await RepositoryRepository.stagePending(db, {
      repositoryId, filesJson, pendingUpdatedAt: timestamp, updatedAt: timestamp,
      expectedPending: desired?.pendingFilesJson ?? null, expectedLatest: repo?.latest_version_id ?? null,
    });
    if ((staged.meta.changes ?? 0) < 1) {
      return configurationConflict(baseRevision, await loadDesiredConfiguration(env, repositoryId));
    }

    const versionNumber = desired
      ? desired.pending ? desired.version.version_number : desired.version.version_number + 1
      : 1;
    const version = {
      created_at: timestamp,
      files,
      id: null,
      message: parsedMessage.value || "Draft captured from desktop",
      previous_version_id: repo?.latest_version_id ?? null,
      revision: incomingRevision,
      source: "pending",
      version_number: versionNumber,
    };
    return json({
      desired: {
        createdAt: timestamp,
        pending: true,
        revision: incomingRevision,
        source: "pending",
        versionId: null,
        versionNumber,
      },
      staged: true,
      version,
    }, { status: 202 });
  }

  const result = await createRepositoryVersionFromFiles(
    env,
    userId,
    repositoryId,
    files,
    parsedMessage.value || "Captured printer configuration",
    "capture",
  );
  if (result.response || !result.version) {
    return result.response ?? json({ error: "Could not record printer capture" }, { status: 500 });
  }

  if (desired?.pending && desired.pendingFilesJson && desired.revision === incomingRevision) {
    await clearRepositoryPending(env, repositoryId, desired.pendingFilesJson);
  }
  const markedApplied = await markPrinterAppliedVersion(
    env,
    repositoryId,
    userId,
    printerId,
    result.version.id,
    result.version.version_number,
  );
  if (!markedApplied) {
    return appliedVersionConflict();
  }

  return json({
    appliedVersion: { version_number: result.version.version_number },
    desired: {
      createdAt: result.version.created_at,
      pending: false,
      revision: incomingRevision,
      source: result.version.source,
      versionId: result.version.id,
      versionNumber: result.version.version_number,
    },
    version: { ...result.version, revision: incomingRevision },
  }, { status: 201 });
}

export async function syncReportHostInfo(request: Request, env: Env, repositoryId: string) {
  const { printerId, response, tokenId, userId } = await requireSyncToken(request, env, repositoryId, "repo:write");
  if (response) {
    return response;
  }

  let resolvedPrinterId = printerId;
  if (!resolvedPrinterId) {
    const candidates = await PrinterRepository.listLegacySyncCandidates(writeDb(env), repositoryId, userId);
    if (candidates.length === 1) {
      resolvedPrinterId = candidates[0].id;
    }
  }

  if (!resolvedPrinterId) {
    return json({ error: "Printer-bound sync token required" }, { status: 400 });
  }

  const parsedBody = await readJsonBody<{
    hostInfo?: unknown;
  } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const hostInfo = parseHostInfo(parsedBody.value?.hostInfo);
  if (!hostInfo) {
    return json({ error: "Host info must be an object of string fields" }, { status: 400 });
  }

  const timestamp = nowIso();
  await PrinterRepository.saveHostInfo(writeDb(env), {
    printerId: resolvedPrinterId, repositoryId, userId, hostInfoJson: JSON.stringify(hostInfo), timestamp,
  });
  if (!printerId) {
    await SyncTokenRepository.bindLegacyPrinter(writeDb(env), tokenId, resolvedPrinterId);
  }

  return json({ hostInfo, ok: true });
}

export async function syncMarkApplied(request: Request, env: Env, repositoryId: string) {
  const { clientMode, printerId, response, userId } = await requireSyncToken(request, env, repositoryId, "repo:write");
  if (response) {
    return response;
  }

  if (!printerId) {
    return json({ error: "Printer-bound sync token required" }, { status: 400 });
  }
  if (clientMode === "desktop") {
    return json({ error: "Desktop clients cannot mark a version as installed on the printer" }, { status: 403 });
  }

  const parsedBody = await readJsonBody<{
    desiredRevision?: string;
    files?: unknown;
    protocolVersion?: number;
    versionNumber?: number;
  } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;
  // Applied reports can immediately follow a variable edit or desired-config
  // update. Keep the complete decision on the primary so an unconstrained
  // replica cannot flatten a just-saved placeholder or mark an older snapshot.
  const db = writeDb(env);
  const desired = await loadDesiredConfiguration(env, repositoryId, db);
  if (desired === "invalid") {
    return invalidStoredConfiguration();
  }

  if (body?.files === undefined && desired?.pending) {
    return json({
      code: "applied_snapshot_required",
      current: desiredConfigurationDescriptor(desired),
      error: "Upgrade the printer client before applying draft configuration",
    }, { status: 409 });
  }

  const latestVersion = await RepositoryRepository.getLatestVersionWithFiles(db, repositoryId);

  let appliedVersion: RepositoryVersionRow | null;
  let appliedRevision: string;

  if (body?.files !== undefined) {
    const synchronizedTemplateFiles = desired
      && typeof body?.desiredRevision === "string"
      && body.desiredRevision === desired.revision
      ? desired.files
      : null;
    const rejectOnlyTemplateFiles = !body?.desiredRevision || synchronizedTemplateFiles
      ? desired?.files ?? null
      : null;
    const validatedApplied = await validateAndPreserveCapture(env, db, {
      errors: {
        emptyFiles: "Applied report contains invalid configuration files",
        invalidFiles: () => "Applied report contains invalid configuration files",
        rejectedPaths: "Applied report contains non-config or sensitive files",
        safetyBlocked: "Safety scan blocked this applied configuration",
        sidecarRequired: "Applied report stopped because host-local variable values could not be safely converted back to placeholders; apply again with the current Klippee client",
      },
      files: body.files,
      printerId,
      rejectOnlyTemplateFiles,
      repositoryId,
      synchronizedTemplateFiles,
      userId,
    });
    if (!validatedApplied.ok) {
      return validatedApplied.response;
    }
    const appliedFiles = validatedApplied.files;
    appliedRevision = validatedApplied.revision;
    if (body?.desiredRevision && body.desiredRevision !== appliedRevision) {
      return json({ error: "Applied configuration does not match its reported revision" }, { status: 400 });
    }

    const latestFiles = latestVersion ? await loadRepositoryFiles(env, latestVersion.files_json) : null;
    if (latestVersion && !latestFiles) {
      return invalidStoredConfiguration();
    }
    if (latestVersion && latestFiles && configFilesMatch(appliedFiles, latestFiles)) {
      appliedVersion = latestVersion;
    } else {
      const printerRow = await PrinterRepository.getSyncName(db, printerId, repositoryId, userId);
      const printerName = printerRow?.name?.trim() || "printer";
      const created = await createRepositoryVersionFromFiles(
        env,
        userId,
        repositoryId,
        appliedFiles,
        `Installed on ${printerName}`,
        "printer-apply",
      );
      if (created.response || !created.version) {
        return created.response ?? json({ error: "Could not record the installed configuration" }, { status: 500 });
      }
      appliedVersion = { ...created.version, files_json: "" };
    }

    if (desired?.pending && desired.pendingFilesJson && desired.revision === appliedRevision) {
      await clearRepositoryPending(env, repositoryId, desired.pendingFilesJson);
    }
  } else {
    const requestedVersion = Number.isInteger(body?.versionNumber) ? body?.versionNumber : desired?.version.version_number;
    if (!requestedVersion) {
      return json({ error: "Repository version not found" }, { status: 404 });
    }
    appliedVersion = await RepositoryRepository.getVersionWithFilesByNumber(db, repositoryId, requestedVersion);
    if (!appliedVersion) {
      return json({ error: "Repository version not found" }, { status: 404 });
    }
    const versionFiles = await loadRepositoryFiles(env, appliedVersion.files_json);
    if (!versionFiles) {
      return invalidStoredConfiguration();
    }
    const safetyFindings = scanConfigFiles(versionFiles);
    if (hasBlockingSafetyFindings(safetyFindings)) {
      return json({ error: "Safety scan blocked this applied configuration", safetyFindings }, { status: 422 });
    }
    appliedRevision = await repositoryFilesRevision(versionFiles);
    if (body?.desiredRevision && body.desiredRevision !== appliedRevision) {
      return configurationConflict(body.desiredRevision, desired);
    }
  }

  const markedApplied = await markPrinterAppliedVersion(
    env,
    repositoryId,
    userId,
    printerId,
    appliedVersion.id,
    appliedVersion.version_number,
  );
  if (!markedApplied) {
    return appliedVersionConflict();
  }
  const currentDesired = await loadDesiredConfiguration(env, repositoryId, db);
  return json({
    appliedVersion: {
      revision: appliedRevision,
      version_number: appliedVersion.version_number,
    },
    desired: currentDesired && currentDesired !== "invalid"
      ? desiredConfigurationDescriptor(currentDesired)
      : null,
    desiredChanged: Boolean(currentDesired && currentDesired !== "invalid" && currentDesired.revision !== appliedRevision),
    ok: true,
  });
}

export async function syncListVersions(request: Request, env: Env, repositoryId: string) {
  const { response } = await requireSyncToken(request, env, repositoryId, "repo:read");
  if (response) {
    return response;
  }

  const result = await RepositoryRepository.listVersions(readDb(env), repositoryId);
  return json({
    versions: result.map((version) => ({
      created_at: version.created_at,
      message: version.message,
      source: version.source,
      version_number: version.version_number,
    })),
  });
}

export async function syncRollbackRepository(request: Request, env: Env, repositoryId: string) {
  const { clientMode, printerId, response, userId } = await requireSyncToken(request, env, repositoryId, "repo:write");
  if (response) {
    return response;
  }
  if (!printerId) {
    return json({ error: "Printer-bound sync token required" }, { status: 400 });
  }
  if (clientMode === "desktop") {
    return json({ error: "Rollback is only available on the physical printer" }, { status: 403 });
  }

  const parsedBody = await readJsonBody<{ versionNumber?: number } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const versionNumber = parsedBody.value?.versionNumber;
  if (!Number.isInteger(versionNumber) || !versionNumber || versionNumber < 1) {
    return json({ error: "Rollback requires a positive versionNumber" }, { status: 400 });
  }

  const db = writeDb(env);
  const quotaState = await RepositoryRepository.countVersions(db, userId, repositoryId);
  const [sourceVersion, latestVersion, desired] = await Promise.all([
    RepositoryRepository.getVersionByNumber(db, repositoryId, versionNumber),
    RepositoryRepository.getLatestVersion(db, repositoryId),
    loadDesiredConfiguration(env, repositoryId, db),
  ]);
  if (desired === "invalid") {
    return invalidStoredConfiguration();
  }
  if (!sourceVersion || !latestVersion) {
    return json({ error: "Rollback version not found" }, { status: 404 });
  }
  if (sourceVersion.version_number === latestVersion.version_number && !desired?.pending) {
    return json({ error: "That version is already latest" }, { status: 409 });
  }
  const files = await loadRepositoryFiles(env, sourceVersion.files_json);
  if (!files) {
    return json({ error: "Stored repository version is invalid" }, { status: 422 });
  }
  const safetyFindings = scanConfigFiles(files);
  if (hasBlockingSafetyFindings(safetyFindings)) {
    return json({ error: "Safety scan blocked this recovery configuration", safetyFindings }, { status: 422 });
  }

  const timestamp = nowIso();
  if (sourceVersion.version_number === latestVersion.version_number) {
    const cleared = await RepositoryRepository.clearPendingAtLatest(db, {
      repositoryId, latestId: latestVersion.id, pendingFilesJson: desired?.pendingFilesJson ?? null, timestamp,
    });
    if ((cleared.meta.changes ?? 0) < 1) {
      return configurationConflict(desired?.revision ?? null, await loadDesiredConfiguration(env, repositoryId));
    }

    await markPrinterLatestVersion(env, repositoryId, userId, printerId, latestVersion.version_number);
    const recovered = await loadDesiredConfiguration(env, repositoryId);
    if (!recovered || recovered === "invalid") {
      return invalidStoredConfiguration();
    }
    return json({
      cancelledDraft: true,
      desired: desiredConfigurationDescriptor(recovered),
      sourceVersionNumber: versionNumber,
      version: {
        ...recovered.version,
        files: recovered.files,
        revision: recovered.revision,
      },
    });
  }

  if ((quotaState?.count ?? 0) >= maxRepositoryVersions) {
    return storageQuotaExceeded("repository-versions", maxRepositoryVersions);
  }

  const recoveryVersionId = crypto.randomUUID();
  const recoveryVersionNumber = latestVersion.version_number + 1;
  const expectedPendingFilesJson = desired?.pendingFilesJson ?? null;
  const recoveryMessage = `Rollback to version ${versionNumber}`;
  // Append the immutable recovery point and replace the exact desired state we
  // observed in one D1 transaction. A newer version or draft makes both
  // statements no-ops, so recovery cannot silently overwrite concurrent work.
  const recoveryWrite = await RepositoryRepository.appendRecovery(db, {
    userId, filesJson: sourceVersion.files_json, latestId: latestVersion.id, pendingFilesJson: expectedPendingFilesJson,
    version: {
      id: recoveryVersionId, repository_id: repositoryId, version_number: recoveryVersionNumber,
      previous_version_id: latestVersion.id, message: recoveryMessage, source: "recovery", created_at: timestamp,
    },
  });
  if ((recoveryWrite[0]?.meta.changes ?? 0) < 1) {
    const currentQuota = await RepositoryRepository.countVersions(db, userId, repositoryId);
    if ((currentQuota?.count ?? 0) >= maxRepositoryVersions) {
      return storageQuotaExceeded("repository-versions", maxRepositoryVersions);
    }
    return configurationConflict(desired?.revision ?? null, await loadDesiredConfiguration(env, repositoryId));
  }
  if ((recoveryWrite[1]?.meta.changes ?? 0) < 1) {
    throw new Error("Recovery version pointer update failed");
  }

  await markPrinterLatestVersion(env, repositoryId, userId, printerId, recoveryVersionNumber);
  const recovered = await loadDesiredConfiguration(env, repositoryId);
  if (!recovered || recovered === "invalid") {
    return invalidStoredConfiguration();
  }
  return json({
    desired: desiredConfigurationDescriptor(recovered),
    sourceVersionNumber: versionNumber,
    version: {
      ...recovered.version,
      files: recovered.files,
      revision: recovered.revision,
    },
  }, { status: 201 });
}
