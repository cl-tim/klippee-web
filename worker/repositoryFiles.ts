import { markCanonicalBlobsStored, reserveCanonicalBlobBudget } from "./blobBudget";
import type { Env, StoredConfigFile } from "./types";
import { isRecord, sha256Hex } from "./util";
import { isRepositoryFilesManifest, parseFiles } from "./validation";
export { repositoryFilesRevision } from "../src/repositoryRevision";

// A version's file set is stored as a "tree": each file's content is written once
// to a global content-addressed blob (blobs/sha256/<hash>), and the version manifest
// (kept in D1 files_json) lists path/role/public + the content hash. Identical file
// content is therefore stored once across every version and repository, instead of
// duplicating a full snapshot per version.
type TreeEntry = {
  byteLength: number;
  path: string;
  public: boolean;
  role: string;
  sha256: string;
};

type RepositoryTreeManifest = {
  entries: TreeEntry[];
  storage: "r2-blobs";
  version: 2;
};

export type RepositoryBlobCache = Map<string, Promise<string | null>>;

function blobKey(hash: string) {
  return `blobs/sha256/${hash}`;
}

function isTreeManifest(value: unknown): value is RepositoryTreeManifest {
  return (
    isRecord(value) &&
    value.storage === "r2-blobs" &&
    value.version === 2 &&
    Array.isArray(value.entries)
  );
}

export async function storeRepositoryFiles(env: Env, userId: string, files: StoredConfigFile[]) {
  const preparedFiles = await Promise.all(files.map(async (file) => {
    const bytes = new TextEncoder().encode(file.content);
    return { bytes, file, hash: await sha256Hex(bytes) };
  }));
  const reservation = await reserveCanonicalBlobBudget(env, userId, preparedFiles.map(({ bytes, hash }) => ({
    sha256: hash,
    sizeBytes: bytes.byteLength,
  })));

  const filesByHash = new Map(preparedFiles.map((file) => [file.hash, file]));
  await Promise.all(
    [...reservation.hashesNeedingStorage].map(async (hash) => {
      const prepared = filesByHash.get(hash);
      if (!prepared) {
        throw new Error("Canonical blob reservation returned an unknown hash");
      }
      const key = blobKey(hash);
      // R2 evaluates this precondition atomically. Concurrent writers may share
      // a content hash, but only the first request creates the immutable blob.
      await env.BLOBS.put(key, prepared.bytes, {
        customMetadata: { sha256: hash },
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
    }),
  );
  await markCanonicalBlobsStored(env, reservation.hashesNeedingStorage);

  const entries = preparedFiles.map(({ bytes, file, hash }) => ({
    byteLength: bytes.byteLength,
    path: file.path,
    public: file.public,
    role: file.role,
    sha256: hash,
  } satisfies TreeEntry));

  const manifest: RepositoryTreeManifest = {
    entries,
    storage: "r2-blobs",
    version: 2,
  };
  return { filesJson: JSON.stringify(manifest), leaseId: reservation.leaseId };
}

async function loadBlobContent(env: Env, entry: TreeEntry): Promise<string | null> {
  const object = await env.BLOBS.get(blobKey(entry.sha256));
  if (!object) {
    return null;
  }
  const content = await object.text();
  if ((await sha256Hex(content)) !== entry.sha256) {
    return null;
  }
  return content;
}

async function cachedBlobContent(env: Env, entry: TreeEntry, cache?: RepositoryBlobCache) {
  if (!cache) return loadBlobContent(env, entry);
  let pending = cache.get(entry.sha256);
  if (!pending) {
    pending = loadBlobContent(env, entry);
    cache.set(entry.sha256, pending);
  }
  return pending;
}

export async function loadRepositoryFiles(env: Env, filesJson: string, blobCache?: RepositoryBlobCache) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(filesJson);
  } catch {
    return null;
  }

  // Legacy inline file array (pre-R2).
  if (Array.isArray(parsed)) {
    return parseFiles(parsed);
  }

  // Current format: per-file content-addressed tree.
  if (isTreeManifest(parsed)) {
    const loaded = await Promise.all(parsed.entries.map(async (entry) => {
      const content = await cachedBlobContent(env, entry, blobCache);
      return content === null ? null : {
        content,
        path: entry.path,
        public: entry.public,
        role: entry.role,
      };
    }));
    if (loaded.some((file) => file === null)) {
      return null;
    }
    return parseFiles(loaded.filter((file): file is StoredConfigFile => file !== null));
  }

  // Legacy v1: whole-snapshot JSON blob in R2.
  if (isRepositoryFilesManifest(parsed)) {
    const cacheKey = `legacy-snapshot:${parsed.key}:${parsed.sha256}`;
    let snapshotText = blobCache?.get(cacheKey);
    if (!snapshotText) {
      snapshotText = (async () => {
        const object = await env.BLOBS.get(parsed.key);
        if (!object) return null;
        const text = await object.text();
        return (await sha256Hex(text)) === parsed.sha256 ? text : null;
      })();
      blobCache?.set(cacheKey, snapshotText);
    }
    const text = await snapshotText;
    if (text === null) return null;
    try {
      return parseFiles(JSON.parse(text));
    } catch {
      return null;
    }
  }

  return null;
}

export function summarizeRepositoryFiles(filesJson: string): StoredConfigFile[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(filesJson);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const files = parseFiles(parsed);
    return files?.map((file) => ({ ...file, content: "" })) ?? null;
  }

  if (isTreeManifest(parsed)) {
    return parseFiles(parsed.entries.map((entry) => ({
      content: "",
      path: entry.path,
      public: entry.public,
      role: entry.role,
    })));
  }

  // Legacy whole-snapshot manifests do not contain file paths. The public
  // package's publish-time summary remains the safe fallback for those rows.
  return null;
}
