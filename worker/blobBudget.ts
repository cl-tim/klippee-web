import { canonicalBlobWriteLeaseTtlSeconds } from "./constants";
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { drizzleDb, writeDb } from "./db";
import { canonicalBlobs, canonicalBlobBudgetReservations, canonicalBlobGcCandidates, canonicalBlobWriteLeases, userBlobClaims } from "./schema";
import { json } from "./http";
import {
  canonicalBlobMinimumChargeBytes,
  maxCanonicalBlobBytesPerUser,
  maxCanonicalBlobBytesTotal,
} from "./storageLimits";
import type { D1Client, Env } from "./types";
import { futureIso, nowIso } from "./util";

export type CanonicalBlobClaim = {
  sha256: string;
  sizeBytes: number;
};

export type BlobStateRow = {
  service_size: number | null;
  sha256: string;
  stored_at: string | null;
  user_size: number | null;
};

export class CanonicalBlobBudgetError extends Error {
  constructor(
    readonly scope: "service" | "user",
    readonly limitBytes: number,
  ) {
    super(scope === "user" ? "User canonical blob budget exceeded" : "Service canonical blob budget exceeded");
    this.name = "CanonicalBlobBudgetError";
  }
}

export class CanonicalBlobReclaimInProgressError extends Error {
  constructor() {
    super("Canonical blob reclamation is in progress");
    this.name = "CanonicalBlobReclaimInProgressError";
  }
}

export function canonicalBlobBudgetResponse(error: CanonicalBlobBudgetError) {
  if (error.scope === "user") {
    return json({
      code: "canonical_blob_budget_exceeded",
      error: "Cloud file-body budget reached. Reuse existing file content or contact the operator to reclaim unreferenced blobs.",
      limitBytes: error.limitBytes,
      resource: "canonical-file-bodies",
    }, { status: 409 });
  }
  return json({
    code: "canonical_blob_capacity_reached",
    error: "Cloud file storage is temporarily at capacity. Try again later.",
    resource: "canonical-file-bodies",
  }, { status: 503 });
}

export function canonicalBlobReclaimInProgressResponse() {
  return json(
    {
      code: "canonical_blob_reclamation_in_progress",
      error: "Cloud file storage maintenance is finishing. Retry shortly.",
      resource: "canonical-file-bodies",
    },
    { headers: { "retry-after": "5" }, status: 503 },
  );
}

/**
 * Deduplicates claims by hash (last occurrence wins) and applies the minimum
 * charge floor so tiny blobs still consume budget. Pure; exported for tests.
 */
export function distinctBlobClaims(claims: CanonicalBlobClaim[]) {
  return [...new Map(claims.map((claim) => [claim.sha256, {
    chargeBytes: Math.max(claim.sizeBytes, canonicalBlobMinimumChargeBytes),
    sha256: claim.sha256,
    sizeBytes: claim.sizeBytes,
  }])).values()];
}

/**
 * Asserts the post-reservation ledger state matches every requested claim
 * byte-for-byte. Pure; exported for tests.
 */
export function validateBlobState(rows: BlobStateRow[], claims: ReturnType<typeof distinctBlobClaims>) {
  if (rows.length !== claims.length) {
    throw new Error("Canonical blob reservation returned incomplete state");
  }
  const claimsByHash = new Map(claims.map((claim) => [claim.sha256, claim]));
  for (const row of rows) {
    const claim = claimsByHash.get(row.sha256);
    if (!claim || row.user_size !== claim.sizeBytes || row.service_size !== claim.sizeBytes) {
      throw new Error("Canonical blob ledger size invariant failed");
    }
  }
}

/**
 * Atomically claims every distinct hash and creates a write lease before R2 is
 * touched. The returned set contains only hashes whose canonical object is not
 * yet confirmed in R2; deduplicated saves still acquire a short-lived lease so
 * reclamation cannot race the later manifest commit.
 */
export async function reserveCanonicalBlobBudget(
  env: Env,
  userId: string,
  claims: CanonicalBlobClaim[],
) {
  const distinctClaims = distinctBlobClaims(claims);
  if (distinctClaims.length === 0) {
    return { hashesNeedingStorage: new Set<string>(), leaseId: null };
  }

  const claimsJson = JSON.stringify(distinctClaims);
  const q = drizzleDb(writeDb(env));
  const reservationId = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const timestamp = nowIso();
  const requested = q.$with("requested").as(q.select({
    sha256: sql<string>`json_extract(value, '$.sha256')`.as("sha256"),
    sizeBytes: sql<number>`CAST(json_extract(value, '$.sizeBytes') AS INTEGER)`.as("size_bytes"),
  }).from(sql`json_each(${claimsJson})`));
  const requestedHash = sql<string>`"requested"."sha256"`;
  const reservationOk = sql`EXISTS (SELECT 1 FROM canonical_blob_budget_reservations
    WHERE id = ${reservationId} AND user_id = ${userId} AND status = 'ok')`;
  const noDeletionFence = sql`NOT EXISTS (
    SELECT 1 FROM canonical_blob_gc_candidates gc
    JOIN requested ON requested.sha256 = gc.sha256 WHERE gc.delete_token IS NOT NULL)`;
  const requestWithCharges = sql`WITH requested AS (
    SELECT json_extract(value, '$.sha256') AS sha256,
      CAST(json_extract(value, '$.sizeBytes') AS INTEGER) AS size_bytes,
      CAST(json_extract(value, '$.chargeBytes') AS INTEGER) AS charge_bytes FROM json_each(${claimsJson})
  )`;
  const writes = await q.batch([
    q.insert(canonicalBlobBudgetReservations).select(sql`${requestWithCharges},
      new_user_claims AS (
        SELECT requested.* FROM requested WHERE NOT EXISTS (
          SELECT 1 FROM user_blob_claims WHERE user_id = ${userId} AND sha256 = requested.sha256)
      ), new_blobs AS (
        SELECT requested.* FROM requested WHERE NOT EXISTS (
          SELECT 1 FROM canonical_blobs WHERE sha256 = requested.sha256)
      ), deltas AS (
        SELECT (SELECT COALESCE(SUM(charge_bytes), 0) FROM new_user_claims) AS user_delta,
          (SELECT COALESCE(SUM(charge_bytes), 0) FROM new_blobs) AS service_delta
      ) SELECT ${reservationId}, ${userId}, CASE
        WHEN deltas.user_delta > 0 AND COALESCE((SELECT charge_bytes FROM user_blob_budget_totals
          WHERE user_id = ${userId}), 0) + deltas.user_delta > ${maxCanonicalBlobBytesPerUser} THEN 'user'
        WHEN deltas.service_delta > 0 AND (SELECT charge_bytes FROM canonical_blob_budget_total WHERE id = 1)
          + deltas.service_delta > ${maxCanonicalBlobBytesTotal} THEN 'service'
        ELSE 'ok' END, ${timestamp} FROM deltas`).returning({ status: canonicalBlobBudgetReservations.status }),
    q.insert(userBlobClaims).select(sql`${requestWithCharges}
      SELECT ${userId}, sha256, size_bytes, charge_bytes, ${timestamp} FROM requested
      WHERE ${reservationOk} AND ${noDeletionFence}`)
      .onConflictDoNothing({ target: [userBlobClaims.userId, userBlobClaims.sha256] }),
    q.insert(canonicalBlobs).select(sql`${requestWithCharges}
      SELECT sha256, size_bytes, charge_bytes, ${timestamp}, NULL FROM requested
      WHERE ${reservationOk} AND ${noDeletionFence}`).onConflictDoNothing({ target: canonicalBlobs.sha256 }),
    q.insert(canonicalBlobWriteLeases).select(sql`WITH requested AS (
      SELECT json_extract(value, '$.sha256') AS sha256,
        CAST(json_extract(value, '$.sizeBytes') AS INTEGER) AS size_bytes FROM json_each(${claimsJson})
      ) SELECT ${leaseId}, ${userId}, canonical_blobs.sha256, ${timestamp}, ${futureIso(canonicalBlobWriteLeaseTtlSeconds)}
      FROM requested JOIN canonical_blobs ON canonical_blobs.sha256 = requested.sha256
        AND canonical_blobs.size_bytes = requested.size_bytes
      WHERE ${reservationOk} AND ${noDeletionFence}`).returning({ sha256: canonicalBlobWriteLeases.sha256 }),
    q.with(requested).select({
      sha256: requestedHash.as("sha256"),
      // D1 batch rows need unique SQL column names before Drizzle maps them.
      user_size: sql<number | null>`${userBlobClaims.sizeBytes}`.as("user_size"),
      service_size: sql<number | null>`${canonicalBlobs.sizeBytes}`.as("service_size"),
      stored_at: canonicalBlobs.storedAt,
    }).from(requested).leftJoin(userBlobClaims,
      and(eq(userBlobClaims.userId, userId), eq(userBlobClaims.sha256, requestedHash)))
      .leftJoin(canonicalBlobs, eq(canonicalBlobs.sha256, requestedHash)),
    q.select({ sha256: canonicalBlobGcCandidates.sha256 }).from(canonicalBlobGcCandidates)
      .where(and(isNotNull(canonicalBlobGcCandidates.deleteToken), inArray(canonicalBlobGcCandidates.sha256,
        q.select({ sha256: sql<string>`json_extract(value, '$.sha256')` }).from(sql`json_each(${claimsJson})`)))).limit(1),
    q.delete(canonicalBlobBudgetReservations).where(and(eq(canonicalBlobBudgetReservations.id, reservationId),
      eq(canonicalBlobBudgetReservations.userId, userId))),
  ]);

  const reservation = writes[0][0];
  if (!reservation) throw new Error("Canonical blob reservation did not return a status");
  if (writes[5].length > 0) throw new CanonicalBlobReclaimInProgressError();
  if (reservation.status === "user") throw new CanonicalBlobBudgetError("user", maxCanonicalBlobBytesPerUser);
  if (reservation.status === "service") throw new CanonicalBlobBudgetError("service", maxCanonicalBlobBytesTotal);
  const rows = writes[4];
  validateBlobState(rows, distinctClaims);
  if (writes[3].length !== distinctClaims.length) {
    throw new Error("Canonical blob write lease reservation returned incomplete state");
  }
  return {
    hashesNeedingStorage: new Set(rows.filter((row) => row.stored_at === null).map((row) => row.sha256)),
    leaseId,
  };
}

export function deleteCanonicalBlobWriteLeaseQuery(db: D1Client, leaseId: string | null) {
  return drizzleDb(db).delete(canonicalBlobWriteLeases)
    .where(sql`${canonicalBlobWriteLeases.leaseId} = ${leaseId}`);
}

export async function removeExpiredCanonicalBlobWriteLeases(env: Env) {
  const q = drizzleDb(writeDb(env));
  const result = await q.delete(canonicalBlobWriteLeases).where(inArray(sql`rowid`,
    q.select({ rowid: sql<number>`rowid` }).from(canonicalBlobWriteLeases)
      .where(lte(canonicalBlobWriteLeases.expiresAt, nowIso()))
      .orderBy(asc(canonicalBlobWriteLeases.expiresAt), asc(canonicalBlobWriteLeases.leaseId), asc(canonicalBlobWriteLeases.sha256)).limit(500),
  )).run();
  return result.meta.changes ?? 0;
}

export async function markCanonicalBlobsStored(env: Env, hashes: Iterable<string>) {
  const distinctHashes = [...new Set(hashes)];
  if (distinctHashes.length === 0) return;
  const q = drizzleDb(writeDb(env));
  await q.update(canonicalBlobs).set({ storedAt: nowIso() }).where(and(isNull(canonicalBlobs.storedAt),
    inArray(canonicalBlobs.sha256, q.select({ value: sql<string>`value` }).from(sql`json_each(${JSON.stringify(distinctHashes)})`)),
  )).run();
}
