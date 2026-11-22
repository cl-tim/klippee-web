import type { ConfigPackage } from "../src/types";
import { loadRepositoryFiles, storeRepositoryFiles } from "./repositoryFiles";
import type { Env, PublicPackageRow } from "./types";
import { isRecord, parseJsonFallback } from "./util";
import { parseConfigPackage, parsePackageVariables, sanitizePublicPackageVariables } from "./validation";

// Package bodies (file contents) are offloaded to content-addressed blobs (reusing
// the #53 tree manifest), so D1 only holds small metadata + variable definitions +
// a manifest pointer. Backward compatible: legacy rows store the full package with
// inline files and are read unchanged.
export async function storeConfigPackageJson(env: Env, userId: string, pkg: ConfigPackage) {
  const storedFiles = await storeRepositoryFiles(env, userId, pkg.files);
  const body: Record<string, unknown> = {
    ...pkg,
    bodyStorage: "r2-blobs",
    bodyVersion: 2,
    filesManifest: storedFiles.filesJson,
  };
  delete body.files;
  return { leaseId: storedFiles.leaseId, packageJson: JSON.stringify(body) };
}

export async function loadStoredConfigPackage(env: Env, packageJson: string): Promise<ConfigPackage | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return null;
  }

  if (isRecord(parsed) && parsed.bodyStorage === "r2-blobs" && typeof parsed.filesManifest === "string") {
    const files = await loadRepositoryFiles(env, parsed.filesManifest);
    if (!files) {
      return null;
    }
    const body: Record<string, unknown> = { ...parsed, files };
    delete body.bodyStorage;
    delete body.bodyVersion;
    delete body.filesManifest;
    return parseConfigPackage(body);
  }

  return parseConfigPackage(parsed);
}

// Variable definitions stay inline in D1 even for offloaded bodies, so secret-name
// lookups never need to fetch file blobs.
export function variableDefinitionsFromStored(packageJson: string) {
  const parsed = parseJsonFallback<unknown>(packageJson, null);
  if (!isRecord(parsed)) {
    return [];
  }
  return parsePackageVariables(parsed.variables) ?? [];
}

export async function publicPackageResponse(env: Env, row: PublicPackageRow) {
  const pkg = await loadStoredConfigPackage(env, row.package_json);
  if (!pkg) {
    return null;
  }
  return {
    ...pkg,
    id: row.slug,
    publicCreatedAt: row.created_at,
    publicSlug: row.slug,
    publicUpdatedAt: row.updated_at,
    publishedAt: row.published_at,
    sourcePackageId: pkg.id,
    variables: sanitizePublicPackageVariables(pkg.variables),
  };
}

// A "summary" is the full package metadata + variable definitions + file paths/roles
// but with empty file contents, so the catalog can be listed straight from D1 without
// fetching any file blobs. Clients hydrate full file contents on demand.
export function summarizeConfigPackage(pkg: ConfigPackage): ConfigPackage {
  return { ...pkg, files: pkg.files.map((file) => ({ ...file, content: "" })) };
}

export function summarizeStoredPackage(packageJson: string): ConfigPackage | null {
  const parsed = parseJsonFallback<unknown>(packageJson, null);
  if (!isRecord(parsed)) {
    return null;
  }

  if (parsed.bodyStorage === "r2-blobs" && typeof parsed.filesManifest === "string") {
    const manifest = parseJsonFallback<unknown>(parsed.filesManifest, null);
    const entries = isRecord(manifest) && Array.isArray(manifest.entries) ? manifest.entries : [];
    const body: Record<string, unknown> = {
      ...parsed,
      files: entries.map((entry) => ({
        content: "",
        path: isRecord(entry) && typeof entry.path === "string" ? entry.path : "",
        public: isRecord(entry) ? entry.public === true : false,
        role: isRecord(entry) && typeof entry.role === "string" ? entry.role : "include",
      })),
    };
    delete body.bodyStorage;
    delete body.bodyVersion;
    delete body.filesManifest;
    return parseConfigPackage(body);
  }

  const parsedPkg = parseConfigPackage(parsed);
  return parsedPkg ? summarizeConfigPackage(parsedPkg) : null;
}
