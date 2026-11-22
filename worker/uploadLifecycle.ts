import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { drizzleDb, writeDb } from "./db";
import { diagnosticUploads, logImprovementSubmissions } from "./schema";
import type { Env } from "./types";
import { nowIso } from "./util";

/**
 * Shared lifecycle for the two expiring R2-backed upload tables. The table
 * name is restricted to this literal union so no user input can ever reach a
 * SQL identifier position.
 */
export type UploadTableName = "diagnostic_uploads" | "log_improvement_submissions";

export type UploadTable = {
  table: UploadTableName;
};

export type UploadObjectRow = {
  id: string;
  r2_key: string;
};

export type UploadScope = { userId: string; printerId?: string };

function uploadModel(uploadTable: UploadTable) {
  return uploadTable.table === "diagnostic_uploads" ? diagnosticUploads : logImprovementSubmissions;
}

function ownerCondition(table: ReturnType<typeof uploadModel>, scope?: UploadScope) {
  if (scope?.printerId && !("printerId" in table)) throw new Error("Printer scope requires diagnostic uploads");
  return scope ? and(eq(table.userId, scope.userId),
    scope.printerId && "printerId" in table ? eq(table.printerId, scope.printerId) : undefined) : undefined;
}

/** Narrows raw D1 result rows to well-formed `{ id, r2_key }` pairs. */
export function uploadObjectRows(results: Record<string, unknown>[] | undefined): UploadObjectRow[] {
  return (results ?? []).flatMap((row) => (
    typeof row.id === "string" && typeof row.r2_key === "string"
      ? [{ id: row.id, r2_key: row.r2_key }]
      : []
  ));
}

/** Deletes R2 objects in chunks below the bulk-delete key limit. */
export async function removeUploadObjects(env: Env, keys: string[]) {
  for (let offset = 0; offset < keys.length; offset += 1_000) {
    await env.BLOBS.delete(keys.slice(offset, offset + 1_000));
  }
}

/**
 * Removes upload rows and their R2 objects. The DELETE is fenced on both id
 * and r2_key so a row that was re-finalized under a different key survives.
 */
export async function removeUploadRows(env: Env, uploadTable: UploadTable, rows: UploadObjectRow[]) {
  if (!rows.length) return;
  await removeUploadObjects(env, rows.map((row) => row.r2_key));
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50);
    const table = uploadModel(uploadTable);
    await drizzleDb(writeDb(env)).delete(table)
      .where(or(...batch.map(row => and(eq(table.id, row.id), eq(table.r2Key, row.r2_key))))).run();
  }
}

/**
 * Sweeps up to 50 expired rows, optionally narrowed
 * to an owner or owner/printer scope.
 */
export async function removeExpiredUploads(
  env: Env,
  uploadTable: UploadTable,
  scope?: UploadScope,
) {
  const table = uploadModel(uploadTable), q = drizzleDb(writeDb(env));
  const expiredIds = q.select({ id: table.id }).from(table)
    .where(and(lte(table.expiresAt, nowIso()), ownerCondition(table, scope)))
    .orderBy(asc(table.expiresAt), asc(table.id)).limit(50);
  const results = await q.batch([
    // Claim pending reservations before touching R2. A negative size is a
    // durable cleanup claim: finalization only accepts size_bytes = 0, so
    // cleanup and the uploader cannot both win across the R2 boundary. If
    // finalization commits first, it also renews expires_at and this batch
    // leaves the now-live row out of both statements.
    q.update(table).set({ sizeBytes: -1 }).where(and(eq(table.sizeBytes, 0), inArray(table.id, expiredIds))),
    q.select({ id: table.id, r2_key: table.r2Key }).from(table).where(inArray(table.id, expiredIds)),
  ]);
  const rows = results[1];
  await removeUploadRows(env, uploadTable, rows);
  return rows.length;
}

/**
 * Expires finalized rows beyond `retentionLimit` for one owner scope
 * (`scope`), newest first, in batches of 50, then removes them.
 */
export async function enforceUploadRetention(
  env: Env,
  uploadTable: UploadTable,
  scope: UploadScope,
  retentionLimit: number,
) {
  const timestamp = nowIso();
  const table = uploadModel(uploadTable), q = drizzleDb(writeDb(env));
  const excess = q.select({ id: table.id }).from(table).where(and(ownerCondition(table, scope), gt(table.sizeBytes, 0)))
    .orderBy(desc(table.createdAt), desc(sql`rowid`)).limit(50).offset(retentionLimit);
  const results = await q.batch([
    q.select({ id: table.id, r2_key: table.r2Key }).from(table).where(inArray(table.id, excess)),
    q.update(table).set({ expiresAt: timestamp }).where(inArray(table.id, excess)),
  ]);
  const rows = results[0];
  await removeUploadRows(env, uploadTable, rows);
  return rows.length;
}

/** True when the buffer starts with the gzip magic bytes (0x1f 0x8b). */
export function isGzipBytes(bytes: ArrayBuffer) {
  const signature = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  return signature.length === 2 && signature[0] === 0x1f && signature[1] === 0x8b;
}

/** True when the buffer starts with a ZIP local/empty/spanned header. */
export function isZipBytes(bytes: ArrayBuffer) {
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return (
    signature.length === 4
    && signature[0] === 0x50
    && signature[1] === 0x4b
    && (
      (signature[2] === 0x03 && signature[3] === 0x04)
      || (signature[2] === 0x05 && signature[3] === 0x06)
      || (signature[2] === 0x07 && signature[3] === 0x08)
    )
  );
}

/**
 * Sanitizes a client-supplied upload file name: strips any directory parts,
 * replaces unsafe characters, caps the length, and falls back to
 * `opts.fallback` unless the cleaned name matches `opts.allowedExtensions`.
 */
export function safeUploadFileName(
  value: string | null,
  opts: { allowedExtensions: RegExp; decodeUri?: boolean; fallback: string },
) {
  let raw = value ?? opts.fallback;
  if (opts.decodeUri) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Keep the original header value when it was not URI encoded.
    }
  }
  const name = raw.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned && opts.allowedExtensions.test(cleaned) ? cleaned : opts.fallback;
}
