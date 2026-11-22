import { and, eq, exists, notExists, sql, type SQL } from "drizzle-orm";
import { drizzleDb, type DrizzleWriteBatch, type DrizzleWriteQuery } from "./db";
import { physicalPrinters, privatePackages, publicPackages, repositoryVersions } from "./schema";
import type { ConfigPackage } from "../src/types";
import { json } from "./http";
import { packageSearchFacets } from "./packageCatalog";
import type { D1Client } from "./types";
import { isRecord, slugify } from "./util";
import { packageIdFromPublishBody } from "./validation";

async function publicPackageIdentitySuffix(userId: string, sourcePackageId: string) {
  const identity = new TextEncoder().encode(`${userId}\u0000${sourcePackageId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", identity));
  return Array.from(digest.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPublicPackageRowId(userId: string, sourcePackageId: string) {
  return `publication-${await publicPackageIdentitySuffix(userId, sourcePackageId)}`;
}

export async function createPublicPackageSlug(pkg: ConfigPackage, userId: string) {
  const suffix = await publicPackageIdentitySuffix(userId, pkg.id);
  const base = slugify(`${pkg.name}-${pkg.version}`) || "config";
  return `${base}-${suffix}`;
}

export type PublishPackageBody = {
  acknowledgeSafetyWarnings: boolean;
  expectedAppliedVersionId: string | null;
  packageId: string;
  printerId: string | null;
  repositoryId: string | null;
};

/**
 * Validates the POST /api/packages/publish payload. Field checks run in the
 * same order as the original inline handler so error precedence (and the exact
 * 400 messages) are unchanged.
 */
export function parsePublishPackageBody(
  body: unknown,
): { ok: false; response: Response } | ({ ok: true } & PublishPackageBody) {
  const packageId = packageIdFromPublishBody(body);
  if (!packageId) {
    return { ok: false, response: json({ error: "Package id is required" }, { status: 400 }) };
  }
  const expectedAppliedVersionIdValue = isRecord(body) ? body.expectedAppliedVersionId : undefined;
  if (
    expectedAppliedVersionIdValue !== undefined
    && (
      typeof expectedAppliedVersionIdValue !== "string"
      || !expectedAppliedVersionIdValue.trim()
      || expectedAppliedVersionIdValue.trim().length > 128
    )
  ) {
    return {
      ok: false,
      response: json({ error: "Expected applied version id must be a non-empty string of at most 128 characters" }, { status: 400 }),
    };
  }
  const expectedAppliedVersionId = typeof expectedAppliedVersionIdValue === "string"
    ? expectedAppliedVersionIdValue.trim()
    : null;
  const repositoryIdValue = isRecord(body) ? body.repositoryId : undefined;
  if (repositoryIdValue !== undefined && (typeof repositoryIdValue !== "string" || !repositoryIdValue.trim())) {
    return { ok: false, response: json({ error: "Repository id must be a non-empty string" }, { status: 400 }) };
  }
  const repositoryId = typeof repositoryIdValue === "string" ? repositoryIdValue.trim() : null;
  const printerIdValue = isRecord(body) ? body.printerId : undefined;
  if (printerIdValue !== undefined && (typeof printerIdValue !== "string" || !printerIdValue.trim())) {
    return { ok: false, response: json({ error: "Printer id must be a non-empty string" }, { status: 400 }) };
  }
  const printerId = typeof printerIdValue === "string" ? printerIdValue.trim() : null;
  if (repositoryId && !printerId) {
    return { ok: false, response: json({ error: "Printer id is required for a linked public configuration" }, { status: 400 }) };
  }
  if (printerId && !repositoryId) {
    return { ok: false, response: json({ error: "Repository id is required for a linked public configuration" }, { status: 400 }) };
  }
  return {
    acknowledgeSafetyWarnings: isRecord(body) && body.acknowledgeSafetyWarnings === true,
    expectedAppliedVersionId,
    ok: true,
    packageId,
    printerId,
    repositoryId,
  };
}

export function createPublicPackagePublishPlan({
  createdAt,
  origin,
  pkg,
  rowId,
  slug,
  timestamp,
  userId,
}: {
  createdAt: string;
  origin: string;
  pkg: ConfigPackage;
  rowId: string;
  slug: string;
  timestamp: string;
  userId: string;
}) {
  const facets = packageSearchFacets(pkg);
  const publicPackage: ConfigPackage = {
    ...pkg,
    id: slug,
    publicCreatedAt: createdAt,
    publicSlug: slug,
    publicUpdatedAt: timestamp,
    publishedAt: timestamp,
    sourcePackageId: pkg.id,
  };

  return {
    response: {
      package: publicPackage,
      publishedAt: timestamp,
      sharePath: `/packages/${slug}`,
      shareUrl: `${origin}/packages/${slug}`,
      slug,
    },
    row: {
      created_at: createdAt,
      id: rowId,
      name: pkg.name,
      printer_facet: facets.printerFacet,
      published_at: timestamp,
      search_text: facets.searchText,
      slug,
      source_package_id: pkg.id,
      tags_facet: facets.tagsFacet,
      title: pkg.title,
      updated_at: timestamp,
      user_id: userId,
    },
  };
}

export type PublicPackagePublishPlan = ReturnType<typeof createPublicPackagePublishPlan>;

/**
 * Builds the guarded public_packages upsert for a publish request. Guard
 * fragments (applied-version freshness for linked listings, first-publication
 * uniqueness) and the ON CONFLICT clause are assembled exactly as the previous
 * inline handler did, so batch semantics and conflict classification are
 * unchanged.
 */
export function buildPublicPackagePublicationStatement(
  db: D1Client,
  {
    approvedVersionId,
    hasExistingPublication,
    linkedPublication,
    packageJson,
    printerId,
    repositoryId,
    row,
    sourcePackageId,
    userId,
  }: {
    approvedVersionId: string | null;
    hasExistingPublication: boolean;
    linkedPublication: boolean;
    packageJson: string;
    printerId: string | null;
    repositoryId: string | null;
    row: PublicPackagePublishPlan["row"];
    sourcePackageId: string;
    userId: string;
  },
): DrizzleWriteQuery {
  const q = drizzleDb(db), p = publicPackages;
  const guards: SQL[] = [];
  if (linkedPublication) {
    guards.push(exists(q.select({ id: physicalPrinters.id }).from(physicalPrinters)
      .innerJoin(repositoryVersions, and(eq(repositoryVersions.repositoryId, physicalPrinters.repositoryId),
        eq(repositoryVersions.versionNumber, physicalPrinters.appliedVersionId)))
      .where(and(sql`${physicalPrinters.id} = ${printerId}`, sql`${physicalPrinters.repositoryId} = ${repositoryId}`,
        eq(physicalPrinters.userId, userId), sql`${repositoryVersions.id} = ${approvedVersionId}`))));
  }
  if (!hasExistingPublication) {
    guards.push(notExists(q.select({ id: p.id }).from(p)
      .where(and(eq(p.userId, userId), eq(p.sourcePackageId, sourcePackageId)))));
  }
  const insert = q.insert(p).select(sql`select ${row.id}, ${row.user_id}, ${row.source_package_id}, ${row.slug},
    ${row.name}, ${row.title}, ${packageJson}, ${row.created_at}, ${row.updated_at}, ${row.published_at},
    ${row.printer_facet}, ${row.tags_facet}, ${row.search_text}, ${repositoryId}, ${printerId}, ${approvedVersionId}, 0, NULL
    where ${and(...guards) ?? sql`1`}`);
  return hasExistingPublication ? insert.onConflictDoUpdate({ target: p.slug, set: {
    autoUpdateEnabled: sql`case when ${p.printerId} is ${printerId} and ${p.repositoryId} is ${repositoryId}
      then ${p.autoUpdateEnabled} else 0 end`,
    repositoryId, printerId, approvedVersionId, autoUpdateError: null,
    name: row.name, title: row.title, packageJson, printerFacet: row.printer_facet,
    tagsFacet: row.tags_facet, searchText: row.search_text, updatedAt: row.updated_at, publishedAt: row.published_at,
  } }) : insert.onConflictDoNothing();
}

export type PublicListingMetadataUpdateInput = {
  expectedPrivate: { packageJson: string; updatedAt: string } | null;
  expectedPublic: {
    approvedVersionId: string | null;
    id: string;
    packageJson: string;
    printerId: string | null;
    repositoryId: string | null;
    updatedAt: string;
  };
  privatePackageJson: string | null;
  privateTitle: string;
  publicPackageJson: string;
  publicSearch: { printerFacet: string; searchText: string; tagsFacet: string };
  timestamp: string;
  title: string;
  userId: string;
  sourcePackageId: string;
};

/**
 * Builds compare-and-swap writes for a listing metadata edit. The public
 * update is guarded by the exact snapshot and approval provenance that were
 * read, plus the private package version when one existed. The private mirror
 * can only update after that public write succeeds and only if its old row is
 * still the one the handler reviewed.
 */
export function buildPublicListingMetadataUpdateStatements(
  db: D1Client,
  input: PublicListingMetadataUpdateInput,
) {
  const q = drizzleDb(db), p = publicPackages, source = privatePackages;
  const privateScope = and(eq(source.userId, input.userId), eq(source.packageId, input.sourcePackageId));
  const privateState = q.select({ one: sql`1` }).from(source).where(and(privateScope,
    input.expectedPrivate ? eq(source.packageJson, input.expectedPrivate.packageJson) : undefined,
    input.expectedPrivate ? eq(source.updatedAt, input.expectedPrivate.updatedAt) : undefined));
  const statements: DrizzleWriteBatch = [q.update(p).set({ title: input.title, packageJson: input.publicPackageJson,
    printerFacet: input.publicSearch.printerFacet, tagsFacet: input.publicSearch.tagsFacet,
    searchText: input.publicSearch.searchText, updatedAt: input.timestamp,
  }).where(and(eq(p.id, input.expectedPublic.id), eq(p.userId, input.userId),
    eq(p.packageJson, input.expectedPublic.packageJson), eq(p.updatedAt, input.expectedPublic.updatedAt),
    sql`${p.approvedVersionId} is ${input.expectedPublic.approvedVersionId}`,
    sql`${p.printerId} is ${input.expectedPublic.printerId}`, sql`${p.repositoryId} is ${input.expectedPublic.repositoryId}`,
    input.expectedPrivate ? exists(privateState) : notExists(privateState)))];
  if (input.privatePackageJson !== null && input.expectedPrivate) {
    const published = q.select({ id: p.id }).from(p).where(and(eq(p.id, input.expectedPublic.id), eq(p.userId, input.userId),
      eq(p.packageJson, input.publicPackageJson), eq(p.updatedAt, input.timestamp)));
    statements.push(q.update(source).set({ title: input.privateTitle, packageJson: input.privatePackageJson, updatedAt: input.timestamp })
      .where(and(privateScope, eq(source.packageJson, input.expectedPrivate.packageJson),
        eq(source.updatedAt, input.expectedPrivate.updatedAt), sql`changes() = 1`, exists(published))));
  }
  return statements;
}
