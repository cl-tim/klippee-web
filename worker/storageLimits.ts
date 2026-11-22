import { json } from "./http";

export const maxRepositoriesPerUser = 32;
export const maxRepositoryVersions = 256;
export const maxPrintersPerUser = 32;
export const maxSyncTokensPerRepository = 16;
export const maxSyncTokenNameBytes = 128;
export const maxPrivatePackagesPerUser = 64;
export const maxCompanionAssetsPerUser = 64;
export const maxActiveSessionsPerUser = 10;
export const maxActiveOAuthStates = 10_000;
export const expiredAuthCleanupBatchSize = 100;
export const syncTokenActivityDebounceSeconds = 15 * 60;
export const canonicalBlobMinimumChargeBytes = 64 * 1_024;
export const maxCanonicalBlobBytesPerUser = 512 * 1_024 * 1_024;
export const maxCanonicalBlobBytesTotal = 20 * 1_024 * 1_024 * 1_024;

export type StorageQuotaResource =
  | "companion-assets"
  | "printers"
  | "private-packages"
  | "repositories"
  | "repository-versions"
  | "sync-tokens";

const resourceLabels: Record<StorageQuotaResource, string> = {
  "companion-assets": "companion assets",
  printers: "printers",
  "private-packages": "private packages",
  repositories: "configuration repositories",
  "repository-versions": "retained repository versions",
  "sync-tokens": "sync tokens for this repository",
};

const recoveryActions: Record<StorageQuotaResource, string> = {
  "companion-assets": "Edit an existing preset or delete an unused one in Orca Workspace > Open preset editor.",
  printers: "Remove an existing printer before creating another.",
  "private-packages": "Edit an existing package or delete an unused one under Shared Configs > Private packages.",
  repositories: "Reuse an existing configuration or delete an unused one under Printers > Saved configurations.",
  "repository-versions": "Remove an unneeded version before creating another.",
  "sync-tokens": "Revoke an existing sync token before creating another.",
};

export function storageQuotaExceeded(resource: StorageQuotaResource, limit: number) {
  return json({
    code: "storage_quota_exceeded",
    error: `Storage limit reached for ${resourceLabels[resource]}. ${recoveryActions[resource]}`,
    limit,
    resource,
  }, { status: 409 });
}
