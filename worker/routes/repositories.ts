import { buildFileDiff } from "../../src/diff";
import { unsafeWorkspaceImportReason } from "../../src/packageBuilder";
import { hasBlockingSafetyFindings, scanConfigFiles } from "../../src/safety";
import { readDb, writeDb } from "../db";
import { json, readJsonBody } from "../http";
import { PrinterRepository } from "../repositories/PrinterRepository";
import { RepositoryRepository } from "../repositories/RepositoryRepository";
import { PublicPackageRepository } from "../repositories/PublicPackageRepository";
import { createEmptyRepositoryCreationPlan, createRepositoryCreationPlan } from "../repositoryCreation";
import { findRepositoryDiffVersions, parseRepositoryDiffParams } from "../repositoryDiff";
import { createRepositoryForkPlan } from "../repositoryFork";
import { loadRepositoryFiles, repositoryFilesRevision, storeRepositoryFiles, type RepositoryBlobCache } from "../repositoryFiles";
import { findRepositoryRestoreVersions, restoreRepositoryFileIntoLatest } from "../repositoryRestoration";
import { buildRepositorySyncStatus } from "../repositorySyncStatus";
import { desiredConfigurationDescriptor, loadDesiredConfiguration } from "../desiredConfiguration";
import { createRepositoryVersionFromFiles, hydrateRepositoryVersions } from "../repositoryVersions";
import { maxRepositoriesPerUser, storageQuotaExceeded } from "../storageLimits";
import type { D1Client, StoredConfigFile } from "../types";
import { withOwnedRepository, withUser } from "../route";
import { removeDiagnosticObjects } from "./diagnosticUploads";
import { nowIso, randomToken, sha256Hex } from "../util";
import {
  describeInvalidFiles,
  normalizeConfigPath,
  parseFiles,
  parseRepositoryVersionMessage,
  parseRepositoryVersionSource,
} from "../validation";

export function ensureRepositoryOwner(db: D1Client, userId: string, repositoryId: string) {
  return RepositoryRepository.getOwned(db, userId, repositoryId);
}

export const listRepositories = withUser(async (_request, env, user, _params, url) => {
  const manage = url.searchParams.get("manage") === "1";
  const db = manage ? writeDb(env) : readDb(env);
  const result = manage
    ? await RepositoryRepository.listForManagement(db, user.id)
    : await RepositoryRepository.listForUser(db, user.id);

  return json({ repositories: result });
});

export const deleteRepository = withOwnedRepository("write", async (request, env, { db, user }, params) => {
  const body = await readJsonBody<{ updatedAt?: unknown; latestVersionId?: unknown } | null>(request);
  if (!body.ok) return body.response;
  if (typeof body.value?.updatedAt !== "string" || !body.value.updatedAt
    || (body.value.latestVersionId !== null && typeof body.value.latestVersionId !== "string")) {
    return json({ error: "Deletion requires the saved configuration's updatedAt and latestVersionId" }, { status: 400 });
  }
  const result = await RepositoryRepository.deleteUnused(db, user.id, params.id, {
    updatedAt: body.value.updatedAt, latestVersionId: body.value.latestVersionId,
  });
  if (!result.deleted) {
    if (!await RepositoryRepository.getOwned(db, user.id, params.id)) {
      return json({ error: "Repository not found" }, { status: 404 });
    }
    return json({
      code: "configuration_delete_conflict",
      error: "This saved configuration changed or is still used by a printer, public listing, or another configuration. Refresh the list and remove any links before deleting it.",
    }, { status: 409 });
  }
  await removeDiagnosticObjects(env, result.diagnosticKeys);
  return json({ ok: true, deletedRepositoryId: params.id });
});

export const createRepository = withUser(async (request, env, user) => {
  const parsedBody = await readJsonBody<{
    empty?: boolean;
    files?: unknown;
    message?: string;
    name?: string;
    title?: string;
  } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;
  const parsedMessage = parseRepositoryVersionMessage(body?.message);
  if (!parsedMessage.ok) {
    return json({ error: parsedMessage.error }, { status: 400 });
  }
  if (body?.empty === true) {
    const repoId = crypto.randomUUID();
    const timestamp = nowIso();
    const plan = createEmptyRepositoryCreationPlan({
      input: body,
      repoId,
      timestamp,
      userId: user.id,
    });
    if (!plan) {
      return json({ error: "Repository name is required" }, { status: 400 });
    }
    const db = writeDb(env);
    const quotaState = await RepositoryRepository.countForUser(db, user.id);
    if ((quotaState?.count ?? 0) >= maxRepositoriesPerUser) {
      return storageQuotaExceeded("repositories", maxRepositoriesPerUser);
    }
    const write = await RepositoryRepository.insertRepository(db, plan.repositoryInsert);
    if ((write.meta.changes ?? 0) !== 1) {
      return storageQuotaExceeded("repositories", maxRepositoriesPerUser);
    }
    return json(plan.response, { status: 201 });
  }
  const files = parseFiles(body?.files ?? []);

  if (!files) {
    return json({ error: describeInvalidFiles(body?.files ?? []) }, { status: 400 });
  }
  const safetyFindings = scanConfigFiles(files);
  if (hasBlockingSafetyFindings(safetyFindings)) {
    return json({ error: "Safety scan blocked this repository", safetyFindings }, { status: 422 });
  }

  const repoId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const timestamp = nowIso();
  const plan = createRepositoryCreationPlan({
    input: {
      ...(body ?? {}),
      message: parsedMessage.value ?? undefined,
    },
    repoId,
    timestamp,
    userId: user.id,
    versionId,
  });
  if (!plan) {
    return json({ error: "Repository name is required" }, { status: 400 });
  }
  const db = writeDb(env);
  const quotaState = await RepositoryRepository.countForUser(db, user.id);
  if ((quotaState?.count ?? 0) >= maxRepositoriesPerUser) {
    return storageQuotaExceeded("repositories", maxRepositoriesPerUser);
  }
  const storedFiles = await storeRepositoryFiles(env, user.id, files);

  const writes = await RepositoryRepository.insertNewRepositoryWithFirstVersion(
    db,
    plan.repositoryInsert,
    plan.versionInsert,
    storedFiles.filesJson,
    storedFiles.leaseId,
  );
  if ((writes[0]?.meta.changes ?? 0) !== 1) {
    return storageQuotaExceeded("repositories", maxRepositoriesPerUser);
  }
  if ((writes[1]?.meta.changes ?? 0) < 1) {
    throw new Error("Initial repository version write failed");
  }

  return json(plan.response, { status: 201 });
});

// This response hydrates the mutable desired editor snapshot as well as
// history. Strong consistency ("write" session) prevents a post-save reload
// from reopening an older immutable version while D1 replication catches up.
export const listRepositoryVersions = withOwnedRepository("write", async (request, env, { db, repo }, params) => {
  const repositoryId = params.id;
  const blobCache: RepositoryBlobCache = new Map();
  const [result, desired] = await Promise.all([
    RepositoryRepository.listVersions(db, repositoryId),
    loadDesiredConfiguration(env, repositoryId, db, blobCache),
  ]);
  if (desired === "invalid") {
    return json({ error: "Stored desired configuration is invalid" }, { status: 422 });
  }

  const versions = await hydrateRepositoryVersions(result, (filesJson) => loadRepositoryFiles(env, filesJson, blobCache));

  if (!versions) {
    return json({ error: "Stored repository version is invalid" }, { status: 422 });
  }

  const response: Record<string, unknown> = {
    desired: desired
      ? {
          ...desiredConfigurationDescriptor(desired),
          files: desired.files,
        }
      : null,
    repository: repo,
    versions,
  };

  if (new URL(request.url).searchParams.get("format") === "content-addressed") {
    const blobs: Record<string, string> = {};
    const hashByContent = new Map<string, Promise<{ byteLength: number; sha256: string }>>();
    async function contentReferences(files: StoredConfigFile[]) {
      return Promise.all(files.map(async ({ content, path, public: isPublic, role }) => {
        let pendingReference = hashByContent.get(content);
        if (!pendingReference) {
          pendingReference = (async () => ({
            byteLength: new TextEncoder().encode(content).byteLength,
            sha256: await sha256Hex(content),
          }))();
          hashByContent.set(content, pendingReference);
        }
        const reference = await pendingReference;
        if (!Object.hasOwn(blobs, reference.sha256)) blobs[reference.sha256] = content;
        return { ...reference, path, public: isPublic, role };
      }));
    }

    const [versionReferences, desiredReferences] = await Promise.all([
      Promise.all(versions.map((version) => contentReferences(version.files))),
      desired ? contentReferences(desired.files) : Promise.resolve(null),
    ]);
    response.storageFormat = "content-addressed-v1";
    response.blobs = blobs;
    response.versions = versions.map((version, index) => ({
      ...version,
      files: versionReferences[index],
    }));
    if (desired && desiredReferences) {
      response.desired = {
        ...desiredConfigurationDescriptor(desired),
        files: desiredReferences,
      };
    }
  }

  return json(response);
});

export const diffRepositoryVersions = withOwnedRepository("read", async (_request, env, { db, repo }, params, url) => {
  const repositoryId = params.id;
  const diffParams = parseRepositoryDiffParams(url);
  if (!diffParams) {
    return json({ error: "Diff requires integer from and to query params" }, { status: 400 });
  }

  const result = await RepositoryRepository.getVersionsByNumbers(
    db,
    repositoryId,
    diffParams.fromVersion,
    diffParams.toVersion,
  );
  const versions = findRepositoryDiffVersions(result, diffParams.fromVersion, diffParams.toVersion);

  if (!versions) {
    return json({ error: "One or both versions were not found" }, { status: 404 });
  }

  const blobCache: RepositoryBlobCache = new Map();
  const [beforeFiles, afterFiles] = await Promise.all([
    loadRepositoryFiles(env, versions.before.files_json, blobCache),
    loadRepositoryFiles(env, versions.after.files_json, blobCache),
  ]);
  if (!beforeFiles || !afterFiles) {
    return json({ error: "Stored repository version is invalid" }, { status: 422 });
  }

  const files = buildFileDiff(beforeFiles, afterFiles);

  return json({
    files,
    fromVersion: diffParams.fromVersion,
    repository: repo,
    toVersion: diffParams.toVersion,
  });
});

export const restoreRepositoryFile = withOwnedRepository("write", async (request, env, { db, user }, params) => {
  const repositoryId = params.id;
  const parsedBody = await readJsonBody<{
    message?: string;
    path?: string;
    sourceVersionNumber?: number;
  } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const path = typeof parsedBody.value?.path === "string" ? normalizeConfigPath(parsedBody.value.path) : null;
  const sourceVersionNumber = parsedBody.value?.sourceVersionNumber;
  if (!path || typeof sourceVersionNumber !== "number" || !Number.isInteger(sourceVersionNumber)) {
    return json({ error: "Restore requires path and integer sourceVersionNumber" }, { status: 400 });
  }

  const result = await RepositoryRepository.getSourceAndLatestVersions(db, repositoryId, sourceVersionNumber);
  const versions = findRepositoryRestoreVersions(result, sourceVersionNumber);

  if (!versions) {
    return json({ error: "Source or latest version was not found" }, { status: 404 });
  }

  const sourceFiles = await loadRepositoryFiles(env, versions.sourceVersion.files_json);
  const latestFiles = await loadRepositoryFiles(env, versions.latestVersion.files_json);
  if (!sourceFiles || !latestFiles) {
    return json({ error: "Stored repository version is invalid" }, { status: 422 });
  }

  const nextFiles = restoreRepositoryFileIntoLatest(sourceFiles, latestFiles, path);
  if (!nextFiles) {
    return json({ error: "Path was not found in source version" }, { status: 404 });
  }

  const parsedMessage = parseRepositoryVersionMessage(parsedBody.value?.message);
  if (!parsedMessage.ok) {
    return json({ error: parsedMessage.error }, { status: 400 });
  }
  const created = await createRepositoryVersionFromFiles(
    env,
    user.id,
    repositoryId,
    nextFiles,
    parsedMessage.value || `Restore ${path} from version ${sourceVersionNumber}`,
    "recovery",
  );
  if (created.response) {
    return created.response;
  }

  return json(
    {
      restoredPath: path,
      sourceVersionNumber,
      version: created.version,
    },
    { status: 201 },
  );
});

export const createRepositoryVersion = withOwnedRepository("write", async (request, env, { user }, params) => {
  const repositoryId = params.id;
  const parsedBody = await readJsonBody<{
    files?: unknown;
    message?: string;
    source?: string;
  } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;
  const files = parseFiles(body?.files);
  if (!files) {
    return json({ error: describeInvalidFiles(body?.files) }, { status: 400 });
  }

  const parsedMessage = parseRepositoryVersionMessage(body?.message);
  if (!parsedMessage.ok) {
    return json({ error: parsedMessage.error }, { status: 400 });
  }
  const parsedSource = parseRepositoryVersionSource(body?.source);
  if (!parsedSource.ok) {
    return json({ error: parsedSource.error }, { status: 400 });
  }
  const source = parsedSource.value || "web-editor";
  const created = await createRepositoryVersionFromFiles(
    env,
    user.id,
    repositoryId,
    files,
    parsedMessage.value,
    source,
  );
  if (created.response) {
    return created.response;
  }

  return json({ version: created.version }, { status: 201 });
});

/**
 * Stage the web editor's current desired configuration for a repository without
 * creating a version. A physical printer serves this on pull and materializes
 * it into a version when it applies (see syncPullRepository / syncMarkApplied).
 * Passing an empty file list clears the staged config.
 */
export const stageRepositoryPending = withOwnedRepository("write", async (request, env, { db, repo }, params) => {
  const repositoryId = params.id;
  const parsedBody = await readJsonBody<{ baseRevision?: unknown; files?: unknown } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;
  const files = parseFiles(parsedBody.value?.files);
  if (!files) {
    return json({ error: describeInvalidFiles(parsedBody.value?.files) }, { status: 400 });
  }
  const rejectedPaths = files
    .filter((file) => unsafeWorkspaceImportReason(file.path) !== null)
    .map((file) => file.path);
  if (rejectedPaths.length > 0) {
    return json({ error: "Staged config contains non-config or sensitive files", rejectedPaths }, { status: 422 });
  }
  const safetyFindings = scanConfigFiles(files);
  if (hasBlockingSafetyFindings(safetyFindings)) {
    return json({ error: "Safety scan blocked this draft", safetyFindings }, { status: 422 });
  }

  const hasValidBaseline = body !== null
    && Object.prototype.hasOwnProperty.call(body, "baseRevision")
    && (body.baseRevision === null || typeof body.baseRevision === "string");
  const desired = await loadDesiredConfiguration(env, repositoryId, db);
  if (desired === "invalid") {
    return json({ error: "Stored desired configuration is invalid" }, { status: 422 });
  }
  if (!hasValidBaseline) {
    return json({
      code: "workspace_baseline_required",
      current: desired ? desiredConfigurationDescriptor(desired) : null,
      error: "Browser draft staging requires a synchronized workspace baseline",
    }, { status: 409 });
  }

  const baseRevision = typeof body?.baseRevision === "string" ? body.baseRevision : null;
  const incomingRevision = files.length > 0 ? await repositoryFilesRevision(files) : null;

  // Retrying the exact current draft is safe even when the caller did not
  // receive the previous response. Clearing an already-clear draft is likewise
  // a no-op; neither path mutates a newer desired configuration.
  if ((incomingRevision !== null && incomingRevision === desired?.revision) || (files.length === 0 && !desired?.pending)) {
    return json({
      desired: desired ? desiredConfigurationDescriptor(desired) : null,
      ok: true,
      staged: Boolean(desired?.pending),
      unchanged: true,
    });
  }

  if (baseRevision !== (desired?.revision ?? null)) {
    return json({
      baseline: { revision: baseRevision },
      code: "desired_configuration_conflict",
      current: desired ? desiredConfigurationDescriptor(desired) : null,
      error: "Desired configuration changed since this browser workspace synchronized",
    }, { status: 409 });
  }

  // A staged browser draft is one mutable, size-bounded D1 value. Keeping it
  // inline means repeatedly replacing a draft cannot strand a new immutable R2
  // blob on every edit; only retained repository versions use blob storage.
  const filesJson = files.length > 0 ? JSON.stringify(files) : null;
  const timestamp = nowIso();
  const staged = await RepositoryRepository.stagePending(db, {
    repositoryId, filesJson, pendingUpdatedAt: filesJson ? timestamp : null, updatedAt: timestamp,
    expectedPending: desired?.pendingFilesJson ?? null, expectedLatest: repo.latest_version_id,
  });
  if ((staged.meta.changes ?? 0) < 1) {
    const current = await loadDesiredConfiguration(env, repositoryId, db);
    if (current === "invalid") {
      return json({ error: "Stored desired configuration is invalid" }, { status: 422 });
    }
    return json({
      baseline: { revision: baseRevision },
      code: "desired_configuration_conflict",
      current: current ? desiredConfigurationDescriptor(current) : null,
      error: "Desired configuration changed while this browser draft was being saved",
    }, { status: 409 });
  }

  const nextDesired = await loadDesiredConfiguration(env, repositoryId, db);
  if (nextDesired === "invalid") {
    return json({ error: "Stored desired configuration is invalid" }, { status: 422 });
  }
  return json({
    desired: nextDesired ? desiredConfigurationDescriptor(nextDesired) : null,
    ok: true,
    staged: Boolean(nextDesired?.pending),
  });
});

type VersionDeleteContext = NonNullable<Awaited<ReturnType<typeof RepositoryRepository.getVersionDeleteContext>>>;

/**
 * Classifies why deleting `versionNumber` is blocked: the version is missing
 * (404), it is the repository's only version, a printer confirmed it as its
 * applied configuration, or an owner-approved publication pins it (all 409).
 * Returns the deletable target when nothing blocks. Used both as the
 * user-friendly preflight and to reclassify a failed guarded deletion from
 * primary D1 state.
 */
async function classifyVersionDeleteBlock(
  db: D1Client,
  repositoryId: string,
  versionNumber: number,
): Promise<{ block: Response; target?: undefined } | { block: null; target: VersionDeleteContext }> {
  const target = await RepositoryRepository.getVersionDeleteContext(db, repositoryId, versionNumber);
  if (!target) {
    return { block: json({ error: "Version not found" }, { status: 404 }) };
  }
  if (target.total_versions <= 1) {
    return { block: json({ error: "A repository must keep at least one version" }, { status: 409 }) };
  }
  const appliedPrinter = await PrinterRepository.findAppliedReference(db, repositoryId, versionNumber);
  if (appliedPrinter) {
    return { block: json({ error: "The last confirmed printer configuration cannot be deleted" }, { status: 409 }) };
  }
  const approvedPublication = await PublicPackageRepository.findApprovedReference(db, repositoryId, target.id);
  if (approvedPublication) {
    return {
      block: json({
        error: "An owner-approved public configuration cannot be deleted until the listing is republished",
      }, { status: 409 }),
    };
  }
  return { block: null, target };
}

export const deleteRepositoryVersion = withUser(async (_request, env, user, params) => {
  const repositoryId = params.id;
  const versionNumber = Number(params.versionNumber);
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    return json({ error: "Version number must be a positive integer" }, { status: 400 });
  }

  const db = writeDb(env);
  const repo = await ensureRepositoryOwner(db, user.id, repositoryId);
  if (!repo) return json({ error: "Repository not found" }, { status: 404 });

  const preflight = await classifyVersionDeleteBlock(db, repositoryId, versionNumber);
  if (preflight.block) return preflight.block;

  const deletion = await RepositoryRepository.deleteVersion(db, user.id, repositoryId, preflight.target, nowIso());
  if ((deletion[3]?.meta.changes ?? 0) < 1) {
    // The preflight above is only an early, user-friendly check. Reclassify a
    // failed guarded mutation from primary D1 state so a concurrent delete,
    // apply, or publication receives an accurate response.
    const currentRepo = await ensureRepositoryOwner(db, user.id, repositoryId);
    if (!currentRepo) return json({ error: "Repository not found" }, { status: 404 });

    const reclassified = await classifyVersionDeleteBlock(db, repositoryId, versionNumber);
    if (reclassified.block) return reclassified.block;
    return json({
      code: "version_delete_conflict",
      error: "Repository history changed while this version was being deleted; reload it and try again",
    }, { status: 409 });
  }
  const [latestVersion, printer] = await Promise.all([
    RepositoryRepository.getLatestVersion(db, repositoryId),
    PrinterRepository.getBound(db, repositoryId, user.id),
  ]);
  return json({ deletedVersionNumber: versionNumber, latestVersion, printer });
});

export const forkRepository = withOwnedRepository("write", async (request, env, { db, repo, user }, params) => {
  const repositoryId = params.id;
  const parsedBody = await readJsonBody<{
    name?: string;
    title?: string;
    versionNumber?: number;
  } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;
  const sourceVersion = await RepositoryRepository.getVersionByNumber(
    db,
    repositoryId,
    body?.versionNumber ?? 1,
  );

  if (!sourceVersion) {
    return json({ error: "Version not found" }, { status: 404 });
  }
  const sourceFiles = await loadRepositoryFiles(env, sourceVersion.files_json);
  if (!sourceFiles) {
    return json({ error: "Stored repository version is invalid" }, { status: 422 });
  }

  const repoId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const timestamp = nowIso();
  const plan = createRepositoryForkPlan({
    files: sourceFiles,
    input: body ?? {},
    repo,
    repoId,
    suffix: randomToken(4).slice(0, 6),
    timestamp,
    userId: user.id,
    versionId,
    versionNumber: sourceVersion.version_number,
  });
  const quotaState = await RepositoryRepository.countForUser(db, user.id);
  if ((quotaState?.count ?? 0) >= maxRepositoriesPerUser) {
    return storageQuotaExceeded("repositories", maxRepositoriesPerUser);
  }
  const storedFiles = await storeRepositoryFiles(env, user.id, sourceFiles);

  const writes = await RepositoryRepository.insertNewRepositoryWithFirstVersion(
    db,
    plan.repositoryInsert,
    plan.versionInsert,
    storedFiles.filesJson,
    storedFiles.leaseId,
  );
  if ((writes[0]?.meta.changes ?? 0) !== 1) {
    return storageQuotaExceeded("repositories", maxRepositoriesPerUser);
  }
  if ((writes[1]?.meta.changes ?? 0) < 1) {
    throw new Error("Initial fork version write failed");
  }

  return json(plan.response, { status: 201 });
});

export const getRepositorySyncStatus = withOwnedRepository("read", async (_request, env, { db, repo, user }, params) => {
  const repositoryId = params.id;
  const [latest, printer, desired] = await Promise.all([
    RepositoryRepository.getLatestVersion(db, repositoryId),
    PrinterRepository.getBound(db, repositoryId, user.id),
    loadDesiredConfiguration(env, repositoryId),
  ]);
  if (desired === "invalid") {
    return json({ error: "Stored desired configuration is invalid" }, { status: 422 });
  }
  return json(buildRepositorySyncStatus({ desired, latest, printer, repository: repo }));
});
