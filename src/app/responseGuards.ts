import type {
  AuthUser,
  CloudDesiredConfiguration,
  CloudRepositoryVersion,
  CloudState,
  PrinterRecord,
  PrinterPublicationCandidate,
  PublicPackageApprovalStatus,
  SyncTokenRecord,
} from "./types";
import type { CompanionAsset, ConfigFile, ConfigPackage } from "../types";

/**
 * Runtime validators for the cloud API response shapes consumed by the UI.
 * They check the smallest set of properties that downstream code reads, then
 * trust the rest of the object. Guard functions return the typed value on
 * success and `null` to reject the response.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArrayOfObjects(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isObject);
}

export function parsePrintersResponse(raw: unknown): { printers: PrinterRecord[] } | null {
  if (!isObject(raw)) return null;
  if (raw.printers === undefined) return { printers: [] };
  if (!isArrayOfObjects(raw.printers)) return null;
  return { printers: raw.printers as unknown as PrinterRecord[] };
}

export function parsePrivatePackagesResponse(raw: unknown): { packages: ConfigPackage[] } | null {
  if (!isObject(raw)) return null;
  if (raw.packages === undefined) return { packages: [] };
  if (!isArrayOfObjects(raw.packages)) return null;
  return { packages: raw.packages as unknown as ConfigPackage[] };
}

export function parseCompanionAssetsResponse(raw: unknown): { assets: CompanionAsset[] } | null {
  if (!isObject(raw)) return null;
  if (raw.assets === undefined) return { assets: [] };
  if (!isArrayOfObjects(raw.assets)) return null;
  return { assets: raw.assets as unknown as CompanionAsset[] };
}

export function parseCompanionAssetResponse(
  raw: unknown,
): { asset: CompanionAsset; shareUrl?: string } | null {
  if (!isObject(raw) || !isObject(raw.asset)) return null;
  const shareUrl = typeof raw.shareUrl === "string" ? raw.shareUrl : undefined;
  return { asset: raw.asset as unknown as CompanionAsset, shareUrl };
}

export function parseRepositoryVersionsResponse(
  raw: unknown,
): { desired: CloudDesiredConfiguration | null; versions: CloudRepositoryVersion[] } | null {
  if (!isObject(raw)) return null;
  if (raw.storageFormat !== undefined) {
    const expanded = expandRepositoryHistory(raw);
    if (!expanded) return null;
    raw = expanded;
  }
  // Expansion produces the same domain shape as the legacy response. Keeping
  // this seam lets reconciliation, restore, and fork use ordinary ConfigFiles.
  if (!isObject(raw)) return null;
  let desired: CloudDesiredConfiguration | null = null;
  if (raw.desired !== undefined && raw.desired !== null) {
    if (
      !isObject(raw.desired)
      || typeof raw.desired.createdAt !== "string"
      || !isArrayOfObjects(raw.desired.files)
      || typeof raw.desired.pending !== "boolean"
      || typeof raw.desired.revision !== "string"
      || typeof raw.desired.source !== "string"
      || (raw.desired.versionId !== null && typeof raw.desired.versionId !== "string")
      || !Number.isInteger(raw.desired.versionNumber)
    ) {
      return null;
    }
    desired = raw.desired as unknown as CloudDesiredConfiguration;
  }
  if (raw.versions === undefined) return { desired, versions: [] };
  if (!isArrayOfObjects(raw.versions)) return null;
  return { desired, versions: raw.versions as unknown as CloudRepositoryVersion[] };
}

/** Validate immutable content addresses before adopting a compact response. */
export async function verifyRepositoryVersionsResponse(raw: unknown) {
  const parsed = parseRepositoryVersionsResponse(raw);
  if (!parsed) return null;
  if (!isObject(raw) || raw.storageFormat === undefined) return parsed;
  if (!isObject(raw.blobs)) return null;
  for (const [hash, content] of Object.entries(raw.blobs)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || typeof content !== "string") return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== hash) return null;
  }
  return parsed;
}

/** Resolve a history's file manifests against its one-copy content table. */
function expandRepositoryHistory(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (
    raw.storageFormat !== "content-addressed-v1"
    || !isObject(raw.blobs)
    || Array.isArray(raw.blobs)
    || !isArrayOfObjects(raw.versions)
  ) return null;

  const blobs = raw.blobs;
  const bodySizes = new Map<string, number>();
  function expandFiles(value: unknown): ConfigFile[] | null {
    if (!isArrayOfObjects(value)) return null;
    const files: ConfigFile[] = [];
    for (const entry of value) {
      if (
        typeof entry.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Object.prototype.hasOwnProperty.call(blobs, entry.sha256)
        || typeof blobs[entry.sha256] !== "string"
        || typeof entry.path !== "string"
        || typeof entry.role !== "string"
        || typeof entry.public !== "boolean"
        || !Number.isSafeInteger(entry.byteLength)
        || (entry.byteLength as number) < 0
      ) return null;

      const content = blobs[entry.sha256] as string;
      let size = bodySizes.get(entry.sha256);
      if (size === undefined) {
        size = new TextEncoder().encode(content).byteLength;
        bodySizes.set(entry.sha256, size);
      }
      if (size !== entry.byteLength) return null;
      files.push({ content, path: entry.path, public: entry.public, role: entry.role });
    }
    return files;
  }

  const versions = [];
  for (const version of raw.versions) {
    const files = expandFiles(version.files);
    if (!files) return null;
    versions.push({ ...version, files });
  }
  let desired = null;
  if (raw.desired !== undefined && raw.desired !== null) {
    if (!isObject(raw.desired)) return null;
    const files = expandFiles(raw.desired.files);
    if (!files) return null;
    desired = { ...raw.desired, files };
  }
  return { desired, versions };
}

export function parseSyncTokensResponse(raw: unknown): { tokens: SyncTokenRecord[] } | null {
  if (!isObject(raw)) return null;
  if (raw.tokens === undefined) return { tokens: [] };
  if (!isArrayOfObjects(raw.tokens)) return null;
  return { tokens: raw.tokens as unknown as SyncTokenRecord[] };
}

export function parseSyncTokenCreateResponse(
  raw: unknown,
): { token: string; tokenRecord?: SyncTokenRecord } | null {
  if (!isObject(raw) || typeof raw.token !== "string") return null;
  return {
    token: raw.token,
    tokenRecord: isObject(raw.tokenRecord) ? raw.tokenRecord as unknown as SyncTokenRecord : undefined,
  };
}

export function parseRepositoryCreateResponse(
  raw: unknown,
): { repository: { id: string; name: string } } | null {
  if (!isObject(raw) || !isObject(raw.repository)) return null;
  const repo = raw.repository as Record<string, unknown>;
  if (typeof repo.id !== "string" || typeof repo.name !== "string") return null;
  return { repository: { id: repo.id, name: repo.name } };
}

export function parseForkResponse(
  raw: unknown,
): { repository: { id: string; name: string }; version: CloudRepositoryVersion } | null {
  if (!isObject(raw) || !isObject(raw.repository) || !isObject(raw.version)) return null;
  const repo = raw.repository;
  if (typeof repo.id !== "string" || typeof repo.name !== "string") return null;
  const version = raw.version;
  if (
    typeof version.created_at !== "string"
    || !isArrayOfObjects(version.files)
    || typeof version.message !== "string"
    || typeof version.source !== "string"
    || !Number.isInteger(version.version_number)
  ) {
    return null;
  }
  return {
    repository: { id: repo.id, name: repo.name },
    version: version as unknown as CloudRepositoryVersion,
  };
}

export function parsePublishPackageResponse(
  raw: unknown,
): { package: ConfigPackage; shareUrl: string } | null {
  if (!isObject(raw) || !isObject(raw.package) || typeof raw.shareUrl !== "string") return null;
  return { package: raw.package as unknown as ConfigPackage, shareUrl: raw.shareUrl };
}

export function parsePublicPackageApprovalStatusResponse(
  raw: unknown,
): { status: PublicPackageApprovalStatus } | null {
  if (!isObject(raw) || !isObject(raw.status)) return null;
  const status = raw.status;
  const nullableVersionId = (value: unknown) => value === null || typeof value === "string";
  if (
    !nullableVersionId(status.approvedVersionId)
    || !nullableVersionId(status.currentAppliedVersionId)
    || typeof status.hasUnpublishedAppliedVersion !== "boolean"
    || typeof status.linked !== "boolean"
    || (status.autoUpdateEnabled !== undefined && typeof status.autoUpdateEnabled !== "boolean")
    || (status.autoUpdateError !== undefined && !nullableVersionId(status.autoUpdateError))
  ) {
    return null;
  }
  return { status: {
    approvedVersionId: status.approvedVersionId as string | null,
    autoUpdateEnabled: status.autoUpdateEnabled === true,
    autoUpdateError: typeof status.autoUpdateError === "string" ? status.autoUpdateError : null,
    currentAppliedVersionId: status.currentAppliedVersionId as string | null,
    hasUnpublishedAppliedVersion: status.hasUnpublishedAppliedVersion,
    linked: status.linked,
  } };
}

export function parsePrinterPublicationCandidateResponse(
  raw: unknown,
): { candidate: PrinterPublicationCandidate | null } | null {
  if (!isObject(raw)) return null;
  if (raw.candidate === null) return { candidate: null };
  if (!isObject(raw.candidate)) return null;
  const candidate = raw.candidate;
  if (
    !(candidate.appliedAt === null || typeof candidate.appliedAt === "string")
    || (typeof candidate.appliedAt === "string" && Number.isNaN(Date.parse(candidate.appliedAt)))
    || typeof candidate.repositoryId !== "string"
    || !candidate.repositoryId
    || typeof candidate.versionId !== "string"
    || !candidate.versionId
    || typeof candidate.versionNumber !== "number"
    || !Number.isInteger(candidate.versionNumber)
    || candidate.versionNumber < 1
    || !Array.isArray(candidate.files)
  ) {
    return null;
  }

  const files = candidate.files.map((value) => {
    if (
      !isObject(value)
      || typeof value.content !== "string"
      || typeof value.path !== "string"
      || !value.path
      || typeof value.public !== "boolean"
      || typeof value.role !== "string"
    ) {
      return null;
    }
    return {
      content: value.content,
      path: value.path,
      public: value.public,
      role: value.role,
    };
  });
  if (files.some((file) => file === null)) return null;

  return {
    candidate: {
      appliedAt: candidate.appliedAt,
      files: files as PrinterPublicationCandidate["files"],
      repositoryId: candidate.repositoryId,
      versionId: candidate.versionId,
      versionNumber: candidate.versionNumber,
    },
  };
}

export function parseAuthMeResponse(raw: unknown): { user: AuthUser | null } | null {
  if (!isObject(raw)) return null;
  if (raw.user === null) return { user: null };
  if (!isObject(raw.user)) return null;
  return { user: raw.user as unknown as AuthUser };
}

export function parseLogoutResponse(raw: unknown): { ok: true } | null {
  return isObject(raw) && raw.ok === true ? { ok: true } : null;
}

export function parseRepoListResponse(
  raw: unknown,
): { repositories: Array<{ id: string; name: string; updated_at: string }> } | null {
  if (!isObject(raw)) return null;
  if (raw.repositories === undefined) return { repositories: [] };
  if (!isArrayOfObjects(raw.repositories)) return null;
  return {
    repositories: raw.repositories as unknown as Array<{ id: string; name: string; updated_at: string }>,
  };
}

export function parseAppStateResponse(raw: unknown): { state: CloudState | null; revision: string | null } | null {
  if (!isObject(raw)) return null;
  if (raw.revision !== undefined && raw.revision !== null && (
    typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.revision)
  )) return null;
  const revision = typeof raw.revision === "string" ? raw.revision : null;
  if (raw.state === null || raw.state === undefined) return { state: null, revision };
  if (!isObject(raw.state)) return null;
  return { state: raw.state as unknown as CloudState, revision };
}

export function parseSharedPackageResponse(raw: unknown): { package: ConfigPackage } | null {
  if (!isObject(raw) || !isObject(raw.package)) return null;
  return { package: raw.package as unknown as ConfigPackage };
}

export function parsePackageListResponse(raw: unknown): { packages: ConfigPackage[] } | null {
  if (!isObject(raw)) return null;
  if (raw.packages === undefined) return { packages: [] };
  if (!isArrayOfObjects(raw.packages)) return null;
  return { packages: raw.packages as unknown as ConfigPackage[] };
}
