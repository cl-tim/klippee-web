import { and, asc, desc, eq, exists, gt, isNull, lte, notExists, sql } from "drizzle-orm";
import { drizzleDb, type DrizzleDb } from "../db";
import { canonicalBlobs as b, canonicalBlobGcCandidates as c, canonicalBlobGcEvents as e,
  canonicalBlobWriteLeases as l, userBlobClaims as u } from "../schema";
import type { D1Client } from "../types";

export type CandidateRow = {
  delete_started_at: string | null;
  delete_token: string | null;
  first_seen_at: string;
  last_checked_at: string;
  last_error: string | null;
  object_etag: string | null;
  object_size_bytes: number | null;
  object_uploaded_at: string | null;
  object_version: string | null;
  r2_key: string;
  reclaim_after: string;
  sha256: string;
};

export type CanonicalStateRow = {
  active_leases: number;
  canonical_created_at: string | null;
  canonical_size_bytes: number | null;
  claim_count: number;
  manifest_references: number;
  normalized_references: number;
  stored_at: string | null;
};

const candidateRecord = {
  r2_key: c.r2Key, sha256: c.sha256, first_seen_at: c.firstSeenAt, last_checked_at: c.lastCheckedAt,
  reclaim_after: c.reclaimAfter, object_size_bytes: c.objectSizeBytes, object_etag: c.objectEtag,
  object_version: c.objectVersion, object_uploaded_at: c.objectUploadedAt,
  delete_token: c.deleteToken, delete_started_at: c.deleteStartedAt, last_error: c.lastError,
};
const eventRecord = {
  id: e.id, r2_key: e.r2Key, sha256: e.sha256, state: e.state, object_size_bytes: e.objectSizeBytes,
  object_etag: e.objectEtag, object_version: e.objectVersion, object_uploaded_at: e.objectUploadedAt,
  started_at: e.startedAt, completed_at: e.completedAt, outcome: e.outcome, error: e.error,
};
type CanonicalReferenceRow = {
  sha256: string; size_bytes: number | null; charge_bytes: number | null; created_at: string | null; stored_at: string | null;
  reference_count: number; manifest_reference_count: number; manifest_only_reference_count: number;
  normalized_only_reference_count: number; owner_count: number; claim_count: number; active_lease_count: number;
};
type LegacyReferenceRow = {
  r2_key: string; sha256: string | null; size_bytes: number | null; reference_count: number; owner_count: number;
};

function unreferenced(q: DrizzleDb, hash: string, timestamp: string) {
  const active = q.select({ sha256: l.sha256 }).from(l).where(and(eq(l.sha256, hash), gt(l.expiresAt, timestamp)));
  return sql`not exists (select 1 from canonical_blob_references where sha256 = ${hash})
    and not exists (select 1 from canonical_blob_manifest_references where sha256 = ${hash})
    and ${notExists(active)}`;
}

export const StorageMaintenanceRepository = {
  state(db: D1Client, hash: string, timestamp: string) {
    return drizzleDb(db).get<CanonicalStateRow>(sql`SELECT
       (SELECT COUNT(*) FROM canonical_blob_references WHERE sha256 = ${hash}) AS normalized_references,
       (SELECT COUNT(*) FROM canonical_blob_manifest_references WHERE sha256 = ${hash}) AS manifest_references,
       (SELECT COUNT(*) FROM canonical_blob_write_leases WHERE sha256 = ${hash} AND expires_at > ${timestamp}) AS active_leases,
       (SELECT COUNT(*) FROM user_blob_claims WHERE sha256 = ${hash}) AS claim_count,
       (SELECT size_bytes FROM canonical_blobs WHERE sha256 = ${hash}) AS canonical_size_bytes,
       (SELECT created_at FROM canonical_blobs WHERE sha256 = ${hash}) AS canonical_created_at,
       (SELECT stored_at FROM canonical_blobs WHERE sha256 = ${hash}) AS stored_at`).then(row => row ?? null);
  },
  listCanonicalReferences(db: D1Client, after: string, timestamp: string) {
    return drizzleDb(db).all<CanonicalReferenceRow>(sql`WITH
       normalized_sources AS MATERIALIZED (
         SELECT source_type, source_id, user_id, sha256
         FROM canonical_blob_references
       ),
       manifest_sources AS MATERIALIZED (
         SELECT DISTINCT source_type, source_id, user_id, sha256
         FROM canonical_blob_manifest_references
       ),
       hashes AS MATERIALIZED (
         SELECT sha256 FROM canonical_blobs WHERE sha256 > ${after}
         UNION
         SELECT sha256 FROM normalized_sources WHERE sha256 > ${after}
         UNION
         SELECT sha256 FROM manifest_sources WHERE sha256 > ${after}
         UNION
         SELECT sha256 FROM user_blob_claims WHERE sha256 > ${after}
         UNION
         SELECT sha256 FROM canonical_blob_write_leases WHERE sha256 > ${after}
         ORDER BY sha256
         LIMIT 500
       ),
       normalized_totals AS (
         SELECT normalized_sources.sha256, COUNT(*) AS reference_count
         FROM normalized_sources JOIN hashes USING (sha256)
         GROUP BY normalized_sources.sha256
       ),
       manifest_totals AS (
         SELECT manifest_sources.sha256, COUNT(*) AS manifest_reference_count
         FROM manifest_sources JOIN hashes USING (sha256)
         GROUP BY manifest_sources.sha256
       ),
       all_owners AS MATERIALIZED (
         SELECT normalized_sources.sha256, normalized_sources.user_id
         FROM normalized_sources JOIN hashes USING (sha256)
         UNION
         SELECT manifest_sources.sha256, manifest_sources.user_id
         FROM manifest_sources JOIN hashes USING (sha256)
       ),
       owner_totals AS (
         SELECT sha256, COUNT(*) AS owner_count
         FROM all_owners
         GROUP BY sha256
       ),
       manifest_only_totals AS (
         SELECT sha256, COUNT(*) AS manifest_only_reference_count
         FROM (
           SELECT manifest_sources.sha256, source_type, source_id, user_id
           FROM manifest_sources JOIN hashes USING (sha256)
           EXCEPT
           SELECT normalized_sources.sha256, source_type, source_id, user_id
           FROM normalized_sources JOIN hashes USING (sha256)
         )
         GROUP BY sha256
       ),
       normalized_only_totals AS (
         SELECT sha256, COUNT(*) AS normalized_only_reference_count
         FROM (
           SELECT normalized_sources.sha256, source_type, source_id, user_id
           FROM normalized_sources JOIN hashes USING (sha256)
           EXCEPT
           SELECT manifest_sources.sha256, source_type, source_id, user_id
           FROM manifest_sources JOIN hashes USING (sha256)
         )
         GROUP BY sha256
       )
     SELECT hashes.sha256,
            canonical_blobs.size_bytes,
            canonical_blobs.charge_bytes,
            canonical_blobs.created_at,
            canonical_blobs.stored_at,
            COALESCE(normalized_totals.reference_count, 0) AS reference_count,
            COALESCE(manifest_totals.manifest_reference_count, 0) AS manifest_reference_count,
            COALESCE(manifest_only_totals.manifest_only_reference_count, 0) AS manifest_only_reference_count,
            COALESCE(normalized_only_totals.normalized_only_reference_count, 0) AS normalized_only_reference_count,
            COALESCE(owner_totals.owner_count, 0) AS owner_count,
            (SELECT COUNT(*) FROM user_blob_claims
             WHERE user_blob_claims.sha256 = hashes.sha256) AS claim_count,
            (SELECT COUNT(*) FROM canonical_blob_write_leases
             WHERE canonical_blob_write_leases.sha256 = hashes.sha256
               AND canonical_blob_write_leases.expires_at > ${timestamp}) AS active_lease_count
     FROM hashes
     LEFT JOIN canonical_blobs USING (sha256)
     LEFT JOIN normalized_totals USING (sha256)
     LEFT JOIN manifest_totals USING (sha256)
     LEFT JOIN manifest_only_totals USING (sha256)
     LEFT JOIN normalized_only_totals USING (sha256)
     LEFT JOIN owner_totals USING (sha256)
     ORDER BY hashes.sha256`);
  },
  listLegacyReferences(db: D1Client, after: string) {
    return drizzleDb(db).all<LegacyReferenceRow>(sql`SELECT r2_key,
            MAX(sha256) AS sha256,
            MAX(size_bytes) AS size_bytes,
            COUNT(*) AS reference_count,
            COUNT(DISTINCT user_id) AS owner_count
     FROM legacy_repository_manifest_references
     WHERE r2_key > ${after}
     GROUP BY r2_key
     ORDER BY r2_key
     LIMIT 500`);
  },
  getCandidate(db: D1Client, key: string) {
    return drizzleDb(db).select(candidateRecord).from(c).where(eq(c.r2Key, key)).get().then(row => row ?? null);
  },
  listReclaims(db: D1Client, after: string) {
    const q = drizzleDb(db);
    return q.batch([
      q.select(candidateRecord).from(c).where(gt(c.r2Key, after)).orderBy(asc(c.r2Key)).limit(500),
      q.select(eventRecord).from(e).orderBy(desc(e.startedAt), desc(e.id)).limit(200),
    ]);
  },
  removeUnfenced(db: D1Client, key: string) {
    return drizzleDb(db).delete(c).where(and(eq(c.r2Key, key), isNull(c.deleteToken))).run();
  },
  observe(db: D1Client, r: Omit<Required<typeof c.$inferInsert>, "deleteToken" | "deleteStartedAt" | "lastError">) {
    const same = sql`${c.objectSizeBytes} is ${r.objectSizeBytes} and ${c.objectEtag} is ${r.objectEtag}
      and ${c.objectVersion} is ${r.objectVersion} and ${c.objectUploadedAt} is ${r.objectUploadedAt}`;
    return drizzleDb(db).insert(c).values({ ...r, deleteToken: null, deleteStartedAt: null, lastError: null })
      .onConflictDoUpdate({ target: c.r2Key, set: {
        sha256: r.sha256,
        firstSeenAt: sql`case when ${same} then ${c.firstSeenAt} else ${r.firstSeenAt} end`,
        reclaimAfter: sql`case when ${same} then ${c.reclaimAfter} else ${r.reclaimAfter} end`,
        lastCheckedAt: r.lastCheckedAt, objectSizeBytes: r.objectSizeBytes, objectEtag: r.objectEtag,
        objectVersion: r.objectVersion, objectUploadedAt: r.objectUploadedAt, lastError: null,
      }, setWhere: isNull(c.deleteToken) }).run();
  },
  markError(db: D1Client, candidate: CandidateRow, error: string, timestamp: string) {
    const q = drizzleDb(db);
    return q.batch([
      q.update(c).set({ lastError: error, lastCheckedAt: timestamp })
        .where(and(eq(c.r2Key, candidate.r2_key), sql`${c.deleteToken} = ${candidate.delete_token}`)),
      q.update(e).set({ error }).where(and(sql`${e.id} = ${candidate.delete_token}`, eq(e.state, "deleting"))),
    ]);
  },
  async acquireFence(db: D1Client, candidate: CandidateRow, token: string, timestamp: string) {
    const q = drizzleDb(db);
    const results = await q.batch([
      q.update(c).set({ deleteToken: token, deleteStartedAt: timestamp, lastError: null }).where(and(
        eq(c.r2Key, candidate.r2_key), eq(c.sha256, candidate.sha256), isNull(c.deleteToken),
        lte(c.reclaimAfter, timestamp), unreferenced(q, candidate.sha256, timestamp),
      )).returning(candidateRecord),
      q.insert(e).select(sql`select ${c.deleteToken}, ${c.r2Key}, ${c.sha256}, 'deleting', ${c.objectSizeBytes},
        ${c.objectEtag}, ${c.objectVersion}, ${c.objectUploadedAt}, ${c.deleteStartedAt}, NULL, NULL, NULL
        from ${c} where ${c.r2Key} = ${candidate.r2_key} and ${c.deleteToken} = ${token}`)
        .onConflictDoNothing({ target: e.id }),
    ]);
    return results[0][0] ?? null;
  },
  async finalize(db: D1Client, candidate: CandidateRow, outcome: "already_missing" | "deleted", timestamp: string) {
    const q = drizzleDb(db), hash = candidate.sha256;
    const noReferences = unreferenced(q, hash, timestamp);
    const fenced = exists(q.select({ key: c.r2Key }).from(c)
      .where(and(eq(c.r2Key, candidate.r2_key), sql`${c.deleteToken} = ${candidate.delete_token}`)));
    const released = and(noReferences,
      notExists(q.select({ sha256: b.sha256 }).from(b).where(eq(b.sha256, hash))),
      notExists(q.select({ sha256: u.sha256 }).from(u).where(eq(u.sha256, hash))));
    const results = await q.batch([
      q.delete(l).where(and(eq(l.sha256, hash), lte(l.expiresAt, timestamp))),
      q.delete(u).where(and(eq(u.sha256, hash), fenced, noReferences)),
      q.delete(b).where(and(eq(b.sha256, hash), fenced, noReferences)),
      q.update(e).set({ state: "reclaimed", completedAt: timestamp, outcome, error: null })
        .where(and(sql`${e.id} = ${candidate.delete_token}`, eq(e.state, "deleting"), released)),
      q.delete(c).where(and(eq(c.r2Key, candidate.r2_key), sql`${c.deleteToken} = ${candidate.delete_token}`, released)),
    ]);
    return (results[4].meta.changes ?? 0) === 1;
  },
};
