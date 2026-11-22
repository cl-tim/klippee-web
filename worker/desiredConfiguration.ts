import { readDb } from "./db";
import { loadRepositoryFiles, repositoryFilesRevision, type RepositoryBlobCache } from "./repositoryFiles";
import { RepositoryRepository } from "./repositories/RepositoryRepository";
import type { D1Client, Env, RepositoryVersionRow, StoredConfigFile } from "./types";

export type DesiredConfiguration = {
  files: StoredConfigFile[];
  pending: boolean;
  pendingFilesJson: string | null;
  revision: string;
  version: Pick<
    RepositoryVersionRow,
    "created_at" | "message" | "previous_version_id" | "source" | "version_number"
  > & { id: string | null };
};

export async function loadDesiredConfiguration(
  env: Env,
  repositoryId: string,
  db: D1Client = readDb(env),
  blobCache?: RepositoryBlobCache,
): Promise<DesiredConfiguration | null | "invalid"> {
  const row = await RepositoryRepository.getDesiredSnapshot(db, repositoryId);

  if (!row) {
    return null;
  }

  const pending = Boolean(row.pending_files_json);
  const filesJson = row.pending_files_json ?? row.version_files_json;
  if (!filesJson) {
    return null;
  }
  const files = await loadRepositoryFiles(env, filesJson, blobCache);
  if (!files) {
    return "invalid";
  }

  const latestVersionNumber = row.version_number ?? 0;
  return {
    files,
    pending,
    pendingFilesJson: row.pending_files_json,
    revision: await repositoryFilesRevision(files),
    version: pending
      ? {
          created_at: row.pending_updated_at ?? new Date().toISOString(),
          id: null,
          message: "Draft changes not yet applied to this printer",
          previous_version_id: row.version_id,
          source: "pending",
          version_number: latestVersionNumber + 1,
        }
      : {
          created_at: row.version_created_at ?? "",
          id: row.version_id,
          message: row.version_message ?? "Applied printer configuration",
          previous_version_id: row.version_previous_id,
          source: row.version_source ?? "printer-apply",
          version_number: latestVersionNumber,
        },
  };
}

export function desiredConfigurationDescriptor(desired: DesiredConfiguration) {
  return {
    createdAt: desired.version.created_at,
    pending: desired.pending,
    revision: desired.revision,
    source: desired.version.source,
    versionId: desired.version.id,
    versionNumber: desired.version.version_number,
  };
}
