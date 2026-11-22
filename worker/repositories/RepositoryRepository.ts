import { and, count, desc, eq, exists, inArray, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { D1Client, RepositoryVersionRow } from "../types";
import { drizzleDb, drizzleReadDb, type DrizzleDb } from "../db";
import { diagnosticUploads, physicalPrinters, publicPackages, repositories, repositoryVersions } from "../schema";
import { maxRepositoriesPerUser, maxRepositoryVersions } from "../storageLimits";
import { deleteCanonicalBlobWriteLeaseQuery } from "../blobBudget";

// Keep existing API field names and projections. Repository summaries must
// not expose owner IDs or staged configuration manifests.
const repositorySummary = {
  id: repositories.id,
  name: repositories.name,
  title: repositories.title,
  latest_version_id: repositories.latestVersionId,
  created_at: repositories.createdAt,
  updated_at: repositories.updatedAt,
};

function repositoryUsage(q: Pick<DrizzleDb, "select">, repositoryId: string | typeof repositories.id) {
  const versions = q.select({ id: repositoryVersions.id }).from(repositoryVersions)
    .where(eq(repositoryVersions.repositoryId, repositoryId));
  const dependent = alias(repositoryVersions, "dependent_version");
  return {
    linked_printer_count: sql<number>`(${q.select({ count: count() }).from(physicalPrinters)
      .where(eq(physicalPrinters.repositoryId, repositoryId))})`.mapWith(Number),
    published_listing_count: sql<number>`(${q.select({ count: count() }).from(publicPackages)
      .where(or(eq(publicPackages.repositoryId, repositoryId), inArray(publicPackages.approvedVersionId, versions)))})`.mapWith(Number),
    dependent_version_count: sql<number>`(${q.select({ count: count() }).from(dependent)
      .where(and(ne(dependent.repositoryId, repositoryId), inArray(dependent.previousVersionId, versions)))})`.mapWith(Number),
  };
}

const versionFiles = {
  version_number: repositoryVersions.versionNumber,
  files_json: repositoryVersions.filesJson,
};

const versionSummary = {
  id: repositoryVersions.id,
  version_number: repositoryVersions.versionNumber,
  message: repositoryVersions.message,
  source: repositoryVersions.source,
  created_at: repositoryVersions.createdAt,
};

const versionRow = {
  ...versionSummary,
  previous_version_id: repositoryVersions.previousVersionId,
  files_json: repositoryVersions.filesJson,
};

export type RepositoryInsert = {
  id: string;
  user_id: string;
  name: string;
  title: string;
  latest_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type RepositoryVersionInsert = {
  id: string;
  repository_id: string;
  version_number: number;
  previous_version_id: string | null;
  message: string;
  source: string;
  created_at: string;
};

function insertRepositoryQuery(q: DrizzleDb, r: RepositoryInsert) {
  const total = q.select({ count: count() }).from(repositories).where(eq(repositories.userId, r.user_id));
  return q.insert(repositories).select(sql`select ${r.id}, ${r.user_id}, ${r.name}, ${r.title},
    ${r.latest_version_id}, ${r.created_at}, ${r.updated_at}, NULL, NULL where (${total}) < ${maxRepositoriesPerUser}`);
}

function insertVersionQuery(q: DrizzleDb, v: RepositoryVersionInsert, filesJson: string, guard: SQL) {
  return q.insert(repositoryVersions).select(sql`select ${v.id}, ${v.repository_id}, ${v.version_number},
    ${v.previous_version_id}, ${v.message}, ${v.source}, ${filesJson}, ${v.created_at} where ${guard}`);
}

/**
 * Repository reads use Drizzle on the caller's D1 session, including primary
 * sessions used before writes. Atomic writes use Drizzle D1 batches.
 */
export const RepositoryRepository = {
  clearPending(db: D1Client, repositoryId: string, expectedFilesJson: string) {
    return drizzleDb(db).update(repositories).set({ pendingFilesJson: null, pendingUpdatedAt: null })
      .where(and(eq(repositories.id, repositoryId), eq(repositories.pendingFilesJson, expectedFilesJson))).run();
  },
  clearPendingAtLatest(db: D1Client, input: {
    repositoryId: string; latestId: string; pendingFilesJson: string | null; timestamp: string;
  }) {
    return drizzleDb(db).update(repositories).set({ pendingFilesJson: null, pendingUpdatedAt: null, updatedAt: input.timestamp })
      .where(and(eq(repositories.id, input.repositoryId), eq(repositories.latestVersionId, input.latestId),
        sql`${repositories.pendingFilesJson} = ${input.pendingFilesJson}`)).run();
  },
  appendRecovery(db: D1Client, input: {
    userId: string; version: RepositoryVersionInsert; filesJson: string; latestId: string; pendingFilesJson: string | null;
  }) {
    const q = drizzleDb(db), v = input.version;
    const expectedState = and(eq(repositories.id, v.repository_id), eq(repositories.userId, input.userId),
      eq(repositories.latestVersionId, input.latestId), sql`${repositories.pendingFilesJson} is ${input.pendingFilesJson}`);
    const owned = q.select({ id: repositories.id }).from(repositories).where(expectedState);
    const total = q.select({ count: count() }).from(repositoryVersions).where(eq(repositoryVersions.repositoryId, v.repository_id));
    const inserted = q.select({ id: repositoryVersions.id }).from(repositoryVersions)
      .where(and(eq(repositoryVersions.id, v.id), eq(repositoryVersions.repositoryId, v.repository_id)));
    return q.batch([
      insertVersionQuery(q, v, input.filesJson, sql`${exists(owned)} and (${total}) < ${maxRepositoryVersions}`),
      q.update(repositories).set({ latestVersionId: v.id, pendingFilesJson: null, pendingUpdatedAt: null, updatedAt: v.created_at })
        .where(and(expectedState, exists(inserted))),
    ]);
  },
  stagePending(db: D1Client, input: {
    repositoryId: string; filesJson: string | null; pendingUpdatedAt: string | null; updatedAt: string;
    expectedPending: string | null; expectedLatest: string | null;
  }) {
    return drizzleDb(db).update(repositories).set({ pendingFilesJson: input.filesJson,
      pendingUpdatedAt: input.pendingUpdatedAt, updatedAt: input.updatedAt,
    }).where(and(eq(repositories.id, input.repositoryId), sql`${repositories.pendingFilesJson} is ${input.expectedPending}`,
      sql`${repositories.latestVersionId} is ${input.expectedLatest}`)).run();
  },
  // Callers authorize the repository before loading its desired snapshot.
  // Follow the stored pointer rather than the highest retained version number.
  getDesiredSnapshot(db: D1Client, repositoryId: string) {
    return drizzleReadDb(db).select({
      pending_files_json: repositories.pendingFilesJson,
      pending_updated_at: repositories.pendingUpdatedAt,
      version_id: repositoryVersions.id,
      version_number: repositoryVersions.versionNumber,
      version_previous_id: repositoryVersions.previousVersionId,
      version_message: repositoryVersions.message,
      version_source: repositoryVersions.source,
      version_files_json: repositoryVersions.filesJson,
      version_created_at: repositoryVersions.createdAt,
    }).from(repositories)
      .leftJoin(repositoryVersions, eq(repositoryVersions.id, repositories.latestVersionId))
      .where(eq(repositories.id, repositoryId)).limit(1).get().then(row => row ?? null);
  },

  countForUser(db: D1Client, userId: string) {
    return drizzleReadDb(db).select({ count: count() }).from(repositories)
      .where(eq(repositories.userId, userId)).get().then(row => row ?? null);
  },

  countVersions(db: D1Client, userId: string, repositoryId: string) {
    return drizzleReadDb(db).select({ count: count(repositoryVersions.id) }).from(repositories)
      .leftJoin(repositoryVersions, eq(repositoryVersions.repositoryId, repositories.id))
      .where(and(eq(repositories.id, repositoryId), eq(repositories.userId, userId)))
      .groupBy(repositories.id).get().then(row => row ?? null);
  },

  listForUser(db: D1Client, userId: string) {
    return drizzleReadDb(db).select(repositorySummary).from(repositories)
      .where(eq(repositories.userId, userId)).orderBy(desc(repositories.updatedAt)).all();
  },

  listForManagement(db: D1Client, userId: string) {
    const q = drizzleReadDb(db);
    const versions = q.select({ count: count() }).from(repositoryVersions)
      .where(eq(repositoryVersions.repositoryId, repositories.id));
    return q.select({
      ...repositorySummary,
      ...repositoryUsage(q, repositories.id),
      version_count: sql<number>`(${versions})`.mapWith(Number),
      pending_draft: sql<number>`case when ${repositories.pendingFilesJson} is null then 0 else 1 end`.mapWith(Number),
    }).from(repositories).where(eq(repositories.userId, userId))
      .orderBy(desc(repositories.updatedAt), repositories.id).all();
  },

  /** Protect references in the DELETE itself; the inventory can be stale. */
  async deleteUnused(db: D1Client, userId: string, repositoryId: string, expected: {
    updatedAt: string; latestVersionId: string | null;
  }) {
    const q = drizzleDb(db);
    const usage = repositoryUsage(q, repositoryId);
    const eligible = and(
      eq(repositories.id, repositoryId), eq(repositories.userId, userId),
      eq(repositories.updatedAt, expected.updatedAt),
      sql`${repositories.latestVersionId} is ${expected.latestVersionId}`,
      sql`${usage.linked_printer_count} = 0`, sql`${usage.published_listing_count} = 0`,
      sql`${usage.dependent_version_count} = 0`,
    );
    // Capture only this eligible deletion's private upload keys in the same
    // transaction as the FK cascades. Canonical file bodies are never deleted.
    const [uploads, deleted] = await q.batch([
      q.select({ r2_key: diagnosticUploads.r2Key }).from(diagnosticUploads).where(and(
        eq(diagnosticUploads.repositoryId, repositoryId),
        exists(q.select({ id: repositories.id }).from(repositories).where(eligible)),
      )),
      q.delete(repositories).where(eligible).returning({ id: repositories.id }),
    ]);
    return { deleted: deleted.length === 1, diagnosticKeys: uploads.map(row => row.r2_key) };
  },

  getOwned(db: D1Client, userId: string, repositoryId: string) {
    return drizzleReadDb(db).select(repositorySummary).from(repositories)
      .where(and(eq(repositories.id, repositoryId), eq(repositories.userId, userId)))
      .get().then(row => row ?? null);
  },

  listVersions(db: D1Client, repositoryId: string) {
    return drizzleReadDb(db).select(versionRow).from(repositoryVersions)
      .where(eq(repositoryVersions.repositoryId, repositoryId))
      .orderBy(desc(repositoryVersions.versionNumber)).all();
  },

  getVersionsByNumbers(db: D1Client, repositoryId: string, fromVersion: number, toVersion: number) {
    return drizzleReadDb(db).select(versionFiles).from(repositoryVersions)
      .where(and(eq(repositoryVersions.repositoryId, repositoryId),
        inArray(repositoryVersions.versionNumber, [fromVersion, toVersion]))).all();
  },

  getVersionByNumber(db: D1Client, repositoryId: string, versionNumber: number) {
    return drizzleReadDb(db).select(versionFiles).from(repositoryVersions)
      .where(and(eq(repositoryVersions.repositoryId, repositoryId), eq(repositoryVersions.versionNumber, versionNumber)))
      .limit(1).get().then(row => row ?? null);
  },

  getVersionWithFilesByNumber(db: D1Client, repositoryId: string, versionNumber: number) {
    return drizzleReadDb(db).select(versionRow).from(repositoryVersions)
      .where(and(eq(repositoryVersions.repositoryId, repositoryId), eq(repositoryVersions.versionNumber, versionNumber)))
      .limit(1).get().then(row => row ?? null);
  },

  getVersionDeleteContext(db: D1Client, repositoryId: string, versionNumber: number) {
    const read = drizzleReadDb(db);
    const total = read.select({ count: count() }).from(repositoryVersions)
      .where(eq(repositoryVersions.repositoryId, repositoryId));
    return read.select({
      id: repositoryVersions.id,
      previous_version_id: repositoryVersions.previousVersionId,
      version_number: repositoryVersions.versionNumber,
      total_versions: sql<number>`(${total})`.mapWith(Number),
    }).from(repositoryVersions)
      .where(and(eq(repositoryVersions.repositoryId, repositoryId), eq(repositoryVersions.versionNumber, versionNumber)))
      .limit(1).get().then(row => row ?? null);
  },

  getSourceAndLatestVersions(db: D1Client, repositoryId: string, sourceVersionNumber: number) {
    const read = drizzleReadDb(db);
    const latest = read.select({ version: repositoryVersions.versionNumber }).from(repositoryVersions)
      .where(eq(repositoryVersions.repositoryId, repositoryId))
      .orderBy(desc(repositoryVersions.versionNumber)).limit(1);
    return read.select(versionFiles).from(repositoryVersions)
      .where(and(eq(repositoryVersions.repositoryId, repositoryId), or(
        eq(repositoryVersions.versionNumber, sourceVersionNumber), inArray(repositoryVersions.versionNumber, latest),
      ))).all();
  },

  /** Latest version with files and lineage for sync and restore paths. */
  getLatestVersionWithFiles(db: D1Client, repositoryId: string) {
    return drizzleReadDb(db).select(versionRow).from(repositoryVersions)
      .where(eq(repositoryVersions.repositoryId, repositoryId)).orderBy(desc(repositoryVersions.versionNumber))
      .limit(1).get().then(row => row ?? null);
  },

  getLatestVersion(db: D1Client, repositoryId: string) {
    return drizzleReadDb(db).select(versionSummary).from(repositoryVersions)
      .where(eq(repositoryVersions.repositoryId, repositoryId)).orderBy(desc(repositoryVersions.versionNumber))
      .limit(1).get().then(row => row ?? null);
  },

  /**
   * Batched INSERT for the new-repository paths (createRepository, fork).
   * The two row inserts go in a single batch so a failure rolls back both.
   */
  insertNewRepositoryWithFirstVersion(
    db: D1Client,
    repositoryInsert: RepositoryInsert,
    versionInsert: RepositoryVersionInsert,
    filesJson: string,
    leaseId: string | null,
  ) {
    const q = drizzleDb(db);
    const owned = q.select({ id: repositories.id }).from(repositories)
      .where(and(eq(repositories.id, repositoryInsert.id), eq(repositories.userId, repositoryInsert.user_id)));
    return q.batch([
      insertRepositoryQuery(q, repositoryInsert),
      insertVersionQuery(q, versionInsert, filesJson, exists(owned)),
      deleteCanonicalBlobWriteLeaseQuery(db, leaseId),
    ]);
  },

  insertRepository(db: D1Client, repositoryInsert: RepositoryInsert) {
    return insertRepositoryQuery(drizzleDb(db), repositoryInsert).run();
  },

  /** Append the immutable version, advance its pointer, and release its lease atomically. */
  appendVersion(db: D1Client, userId: string, v: RepositoryVersionInsert, filesJson: string, leaseId: string | null) {
    const q = drizzleDb(db);
    const owned = q.select({ id: repositories.id }).from(repositories)
      .where(and(eq(repositories.id, v.repository_id), eq(repositories.userId, userId)));
    const total = q.select({ count: count() }).from(repositoryVersions).where(eq(repositoryVersions.repositoryId, v.repository_id));
    const inserted = q.select({ id: repositoryVersions.id }).from(repositoryVersions)
      .where(and(eq(repositoryVersions.id, v.id), eq(repositoryVersions.repositoryId, v.repository_id)));
    return q.batch([
      insertVersionQuery(q, v, filesJson, sql`${exists(owned)} and (${total}) < ${maxRepositoryVersions}`),
      q.update(repositories).set({ latestVersionId: v.id, updatedAt: v.created_at })
        .where(and(eq(repositories.id, v.repository_id), eq(repositories.userId, userId), exists(inserted))),
      deleteCanonicalBlobWriteLeaseQuery(db, leaseId),
    ]);
  },

  /**
   * Latest (id, version_number) for the conflict-aware append path. Lighter
   * than `getLatestVersion` because the retry loop only needs these two
   * columns.
   */
  getLatestVersionId(db: D1Client, repositoryId: string) {
    return drizzleReadDb(db).select({ id: repositoryVersions.id, version_number: repositoryVersions.versionNumber })
      .from(repositoryVersions).where(eq(repositoryVersions.repositoryId, repositoryId))
      .orderBy(desc(repositoryVersions.versionNumber)).limit(1).get().then(row => row ?? null);
  },

  deleteVersion(
    db: D1Client,
    userId: string,
    repositoryId: string,
    target: Pick<RepositoryVersionRow, "id" | "previous_version_id" | "version_number">,
    timestamp: string,
  ) {
    const q = drizzleDb(db), owned = alias(repositories, "owned_repository"), version = alias(repositoryVersions, "target_version");
    // Repeat eligibility at each mutation boundary; a competing delete or a
    // newly pinned version makes the complete transaction a no-op.
    const total = q.select({ count: count() }).from(repositoryVersions).where(eq(repositoryVersions.repositoryId, owned.id));
    const eligible = exists(q.select({ id: owned.id }).from(owned)
      .innerJoin(version, eq(version.repositoryId, owned.id)).where(and(
        eq(owned.id, repositoryId), eq(owned.userId, userId), eq(version.id, target.id),
        eq(version.versionNumber, target.version_number), sql`(${total}) > 1`,
        notExists(q.select({ id: physicalPrinters.id }).from(physicalPrinters).where(and(
          eq(physicalPrinters.repositoryId, owned.id), eq(physicalPrinters.appliedVersionId, version.versionNumber)))),
        notExists(q.select({ id: publicPackages.id }).from(publicPackages).where(and(
          eq(publicPackages.repositoryId, owned.id), eq(publicPackages.approvedVersionId, version.id)))),
      )));
    const previous = q.select({ id: repositoryVersions.previousVersionId }).from(repositoryVersions)
      .where(and(eq(repositoryVersions.repositoryId, repositoryId), eq(repositoryVersions.id, target.id)));
    const remaining = and(eq(repositoryVersions.repositoryId, repositoryId), ne(repositoryVersions.id, target.id));
    const latest = q.select({ id: repositoryVersions.id }).from(repositoryVersions).where(remaining)
      .orderBy(desc(repositoryVersions.versionNumber)).limit(1);
    const maximum = q.select({ version: sql<number | null>`max(${repositoryVersions.versionNumber})` })
      .from(repositoryVersions).where(remaining);
    return q.batch([
      q.update(repositoryVersions).set({ previousVersionId: sql`(${previous})` }).where(and(
        eq(repositoryVersions.repositoryId, repositoryId), eq(repositoryVersions.previousVersionId, target.id), eligible)),
      q.update(repositories).set({ latestVersionId: sql`(${latest})`, updatedAt: timestamp })
        .where(and(eq(repositories.id, repositoryId), eq(repositories.userId, userId), eligible)),
      q.update(physicalPrinters).set({ latestVersionId: sql`coalesce((${maximum}), 0)`, updatedAt: timestamp })
        .where(and(eq(physicalPrinters.repositoryId, repositoryId), eligible)),
      q.delete(repositoryVersions).where(and(eq(repositoryVersions.repositoryId, repositoryId), eq(repositoryVersions.id, target.id), eligible)),
    ]);
  },
};
