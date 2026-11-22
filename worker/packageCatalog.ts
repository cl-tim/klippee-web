import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { ConfigPackage } from "../src/types";
import { drizzleReadDb, readDb } from "./db";
import { json } from "./http";
import { summarizeConfigPackage, summarizeStoredPackage } from "./packageStorage";
import type { Env } from "./types";
import { publicPackages } from "./schema";
import { sanitizePublicPackageVariables } from "./validation";

export type PackageFilters = {
  q?: string;
  tag?: string;
  printer?: string;
};

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function queryTerms(value: string) {
  return value.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

/**
 * Cache key for the public package listing. Keyed on the configured
 * APP_ORIGIN (not the request's own origin) so key construction agrees with
 * `deleteDefaultPublicPackageCache` invalidation even when the Worker is
 * reachable through a secondary hostname.
 */
export function publicPackageCacheKey(request: Request, appOrigin: string) {
  const url = new URL(request.url);
  const keyUrl = new URL("/api/packages", appOrigin);
  for (const name of ["printer", "q", "tag"]) {
    const value = url.searchParams.get(name);
    if (value) {
      keyUrl.searchParams.set(name, value);
    }
  }
  return new Request(keyUrl, { method: "GET" });
}

export async function deleteDefaultPublicPackageCache(env: Env) {
  if (typeof caches === "undefined") {
    return;
  }

  try {
    await caches.default.delete(new Request(new URL("/api/packages", env.APP_ORIGIN), { method: "GET" }));
  } catch {
    // Cache invalidation is best-effort; writes should still succeed if the edge cache is unavailable.
  }
}

// Denormalized facets stored alongside each public package (see migration 0010)
// so discovery queries never have to scan and JSON-parse every row.
export function packageSearchFacets(pkg: ConfigPackage) {
  return {
    printerFacet: (pkg.printer ?? "").toLowerCase(),
    searchText: [pkg.title, pkg.description, pkg.printer, pkg.hardware.join(" "), pkg.tags.join(" ")]
      .join(" ")
      .toLowerCase(),
    tagsFacet: `|${pkg.tags.map((tag) => tag.toLowerCase()).join("|")}|`,
  };
}

export function bundledPackageMatches(pkg: ConfigPackage, filters: PackageFilters) {
  if (filters.printer && pkg.printer.toLowerCase() !== filters.printer.toLowerCase()) {
    return false;
  }
  const tag = filters.tag?.toLowerCase();
  if (tag && !pkg.tags.some((candidate) => candidate.toLowerCase() === tag)) {
    return false;
  }
  if (filters.q) {
    const haystack = [pkg.title, pkg.description, pkg.printer, pkg.hardware.join(" "), pkg.tags.join(" ")]
      .join(" ")
      .toLowerCase();
    return queryTerms(filters.q).every((term) => haystack.includes(term));
  }
  return true;
}

export async function queryPublicPackageRows(env: Env, filters: PackageFilters = {}) {
  const clauses: SQL[] = [];

  if (filters.tag) {
    clauses.push(sql`${publicPackages.tagsFacet} LIKE ${`%|${escapeLike(filters.tag.toLowerCase())}|%`} ESCAPE '\\'`);
  }
  if (filters.printer) {
    clauses.push(eq(publicPackages.printerFacet, filters.printer.toLowerCase()));
  }
  for (const term of queryTerms(filters.q ?? "")) {
    clauses.push(sql`${publicPackages.searchText} LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`);
  }

  try {
    return await drizzleReadDb(readDb(env)).select({
      slug: publicPackages.slug,
      package_json: publicPackages.packageJson,
      repository_id: publicPackages.repositoryId,
      printer_id: publicPackages.printerId,
      approved_version_id: publicPackages.approvedVersionId,
      created_at: publicPackages.createdAt,
      updated_at: publicPackages.updatedAt,
      published_at: publicPackages.publishedAt,
    }).from(publicPackages).where(and(...clauses)).orderBy(desc(publicPackages.updatedAt)).all();
  } catch {
    return [];
  }
}

export async function listPackageSummaries(env: Env, bundledPackages: ConfigPackage[], filters: PackageFilters) {
  const rows = await queryPublicPackageRows(env, filters);
  const publicSummaries = rows
    .map((row) => {
      const pkg = summarizeStoredPackage(row.package_json);
      return pkg
        ? {
            ...pkg,
            id: row.slug,
            publicCreatedAt: row.created_at,
            publicSlug: row.slug,
            publicUpdatedAt: row.updated_at,
            publishedAt: row.published_at,
            sourcePackageId: pkg.id,
            tracksAppliedConfiguration: Boolean(
              row.repository_id && row.printer_id && row.approved_version_id
            ),
          }
        : null;
    })
    .filter((pkg) => pkg !== null);
  const bundledSummaries = bundledPackages
    .filter((pkg) => bundledPackageMatches(pkg, filters))
    .map(summarizeConfigPackage);
  return [...publicSummaries, ...bundledSummaries];
}

export function packageSummariesResponse(packages: ConfigPackage[]) {
  return json({
    packages: packages.map((pkg) => ({
      description: pkg.description,
      files: pkg.files.map((file) => ({
        content: file.content,
        path: file.path,
        public: file.public,
        role: file.role,
      })),
      hardware: pkg.hardware,
      id: pkg.id,
      name: pkg.name,
      printer: pkg.printer,
      publicCreatedAt: pkg.publicCreatedAt,
      publicSlug: pkg.publicSlug,
      publicUpdatedAt: pkg.publicUpdatedAt,
      publishedAt: pkg.publishedAt,
      sourcePackageId: pkg.sourcePackageId,
      tags: pkg.tags,
      title: pkg.title,
      tracksAppliedConfiguration: pkg.tracksAppliedConfiguration,
      variables: sanitizePublicPackageVariables(pkg.variables),
      version: pkg.version,
      warnings: pkg.warnings,
    })),
  }, {
    headers: {
      "cache-control": "public, max-age=60",
      "x-klippee-cache": "MISS",
    },
  });
}
