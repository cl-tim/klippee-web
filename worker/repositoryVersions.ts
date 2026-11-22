import { hasBlockingSafetyFindings, scanConfigFiles } from "../src/safety";
import type { ConfigFile } from "../src/types";
import { writeDb } from "./db";
import { unwrapDatabaseError } from "./databaseErrors";
import { json } from "./http";
import { RepositoryRepository } from "./repositories/RepositoryRepository";
import { storeRepositoryFiles } from "./repositoryFiles";
import { maxRepositoryVersions, storageQuotaExceeded } from "./storageLimits";
import type { Env, RepositoryVersionRow } from "./types";
import { nowIso } from "./util";
import {
  describeInvalidFiles,
  parseFiles,
  parseRepositoryVersionMessage,
  parseRepositoryVersionSource,
} from "./validation";

function isRetryableVersionWriteError(error: unknown) {
  error = unwrapDatabaseError(error);
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("D1_") ||
    message.includes("SQLITE_BUSY") ||
    message.includes("database is locked") ||
    (message.includes("UNIQUE constraint failed") && message.includes("repository_versions"))
  );
}

function retryDelay(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
}

export async function hydrateRepositoryVersions(
  rows: RepositoryVersionRow[],
  loadFiles: (filesJson: string) => Promise<ConfigFile[] | null>,
) {
  const versions = await Promise.all(rows.map(async ({ files_json: filesJson, ...version }) => {
    const files = await loadFiles(filesJson);
    return files ? { ...version, files } : null;
  }));

  return versions.every((version) => version !== null) ? versions : null;
}

export async function createRepositoryVersionFromFiles(
  env: Env,
  userId: string,
  repositoryId: string,
  files: unknown,
  message: string | null,
  source: string,
) {
  const parsedMessage = parseRepositoryVersionMessage(message);
  if (!parsedMessage.ok) {
    return { response: json({ error: parsedMessage.error }, { status: 400 }), version: null };
  }
  const parsedSource = parseRepositoryVersionSource(source);
  if (!parsedSource.ok) {
    return { response: json({ error: parsedSource.error }, { status: 400 }), version: null };
  }
  if (!parsedSource.value) {
    return { response: json({ error: "Version source is required" }, { status: 400 }), version: null };
  }

  const parsedFiles = parseFiles(files);
  if (!parsedFiles) {
    return { response: json({ error: describeInvalidFiles(files) }, { status: 400 }), version: null };
  }
  const safetyFindings = scanConfigFiles(parsedFiles);
  if (hasBlockingSafetyFindings(safetyFindings)) {
    return {
      response: json({ error: "Safety scan blocked this version", safetyFindings }, { status: 422 }),
      version: null,
    };
  }

  const db = writeDb(env);
  const quotaState = await RepositoryRepository.countVersions(db, userId, repositoryId);
  if (quotaState && quotaState.count >= maxRepositoryVersions) {
    return {
      response: storageQuotaExceeded("repository-versions", maxRepositoryVersions),
      version: null,
    };
  }
  const storedFiles = await storeRepositoryFiles(env, userId, parsedFiles);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const latest = await RepositoryRepository.getLatestVersionId(db, repositoryId);
    const versionId = crypto.randomUUID();
    const versionNumber = (latest?.version_number ?? 0) + 1;
    const timestamp = nowIso();
    const versionMessage = parsedMessage.value || `Version ${versionNumber}`;

    try {
      const write = await RepositoryRepository.appendVersion(
        db,
        userId,
        {
          id: versionId,
          repository_id: repositoryId,
          version_number: versionNumber,
          previous_version_id: latest?.id ?? null,
          message: versionMessage,
          source: parsedSource.value,
          created_at: timestamp,
        },
        storedFiles.filesJson,
        storedFiles.leaseId,
      );
      if ((write[0]?.meta.changes ?? 0) < 1) {
        return {
          response: storageQuotaExceeded("repository-versions", maxRepositoryVersions),
          version: null,
        };
      }
      if ((write[1]?.meta.changes ?? 0) < 1) {
        throw new Error("Repository version pointer update failed");
      }
      return {
        response: null,
        version: {
          created_at: timestamp,
          files: parsedFiles,
          id: versionId,
          message: versionMessage,
          previous_version_id: latest?.id ?? null,
          source: parsedSource.value,
          version_number: versionNumber,
        },
      };
    } catch (error) {
      if (!isRetryableVersionWriteError(error) || attempt === 7) {
        throw error;
      }
      await retryDelay(attempt);
    }
  }

  return { response: json({ error: "Repository version conflict" }, { status: 409 }), version: null };
}
