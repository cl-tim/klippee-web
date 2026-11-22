import { and, count, desc, eq, exists, gt, sql } from "drizzle-orm";
import { drizzleDb, type DrizzleDb } from "../db";
import { diagnosticUploads as d, physicalPrinters as p, syncTokens as t } from "../schema";
import type { D1Client } from "../types";

type Principal = { tokenId: string; userId: string; repositoryId: string; printerId: string };
const record = {
  id: d.id, user_id: d.userId, printer_id: d.printerId, repository_id: d.repositoryId,
  file_name: d.fileName, content_type: d.contentType, size_bytes: d.sizeBytes, original_size_bytes: d.originalSizeBytes,
  truncated: d.truncated, r2_key: d.r2Key, created_at: d.createdAt, expires_at: d.expiresAt,
};
function ownership(q: DrizzleDb, principal: Principal) {
  return q.select({ id: t.id }).from(t).innerJoin(p, eq(p.id, t.printerId)).where(and(
    eq(t.id, principal.tokenId), eq(t.userId, principal.userId), eq(t.repositoryId, principal.repositoryId),
    eq(t.printerId, principal.printerId), eq(p.userId, t.userId), eq(p.repositoryId, t.repositoryId),
  ));
}

export const DiagnosticUploadRepository = {
  hasOwnership(db: D1Client, principal: Principal) {
    return ownership(drizzleDb(db), principal).get().then(row => row ?? null);
  },
  reserve(db: D1Client, principal: Principal, r: Omit<Required<typeof d.$inferInsert>, "sizeBytes">, limit: number) {
    const q = drizzleDb(db);
    const total = q.select({ count: count() }).from(d).where(and(eq(d.userId, principal.userId), eq(d.printerId, principal.printerId)));
    return q.insert(d).select(sql`select ${r.id}, ${r.userId}, ${r.printerId}, ${r.repositoryId}, ${r.fileName}, ${r.contentType},
      0, ${r.originalSizeBytes}, ${r.truncated}, ${r.r2Key}, ${r.createdAt}, ${r.expiresAt}
      where (${total}) < ${limit} and ${exists(ownership(q, principal))}`).run();
  },
  finalize(db: D1Client, principal: Principal, id: string, key: string, sizeBytes: number, expiresAt: string) {
    const q = drizzleDb(db);
    return q.update(d).set({ sizeBytes, expiresAt }).where(and(eq(d.id, id), eq(d.r2Key, key),
      eq(d.sizeBytes, 0), exists(ownership(q, principal)))).run();
  },
  listForUser(db: D1Client, userId: string, timestamp: string) {
    return drizzleDb(db).select({ ...record, printer_name: p.name }).from(d).innerJoin(p, eq(p.id, d.printerId))
      .where(and(eq(d.userId, userId), gt(d.expiresAt, timestamp), gt(d.sizeBytes, 0))).orderBy(desc(d.createdAt)).limit(50).all();
  },
  getForUser(db: D1Client, id: string, userId: string, timestamp: string) {
    return drizzleDb(db).select(record).from(d).where(and(eq(d.id, id), eq(d.userId, userId),
      gt(d.expiresAt, timestamp), gt(d.sizeBytes, 0))).get().then(row => row ?? null);
  },
  getObjectForOwner(db: D1Client, id: string, userId: string) {
    return drizzleDb(db).select({ id: d.id, r2_key: d.r2Key }).from(d)
      .where(and(eq(d.id, id), eq(d.userId, userId))).get().then(row => row ?? null);
  },
};
