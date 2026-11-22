import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { drizzleDb } from "../db";
import { logImprovementSubmissions as s } from "../schema";
import type { D1Client } from "../types";

const record = {
  id: s.id, user_id: s.userId, original_file_name: s.originalFileName, file_name: s.fileName,
  size_bytes: s.sizeBytes, original_size_bytes: s.originalSizeBytes, sha256: s.sha256, r2_key: s.r2Key,
  consent_version: s.consentVersion, consented_at: s.consentedAt, redaction_confirmed: s.redactionConfirmed,
  created_at: s.createdAt, expires_at: s.expiresAt,
};

export const LogSubmissionRepository = {
  reserve(db: D1Client, r: Omit<Required<typeof s.$inferInsert>, "sizeBytes" | "redactionConfirmed">, limit: number) {
    const q = drizzleDb(db), total = q.select({ count: count() }).from(s).where(eq(s.userId, r.userId));
    return q.insert(s).select(sql`select ${r.id}, ${r.userId}, ${r.originalFileName}, ${r.fileName}, 0, ${r.originalSizeBytes},
      ${r.sha256}, ${r.r2Key}, ${r.consentVersion}, ${r.consentedAt}, 1, ${r.createdAt}, ${r.expiresAt}
      where (${total}) < ${limit}`).run();
  },
  finalize(db: D1Client, id: string, key: string, sizeBytes: number, expiresAt: string) {
    return drizzleDb(db).update(s).set({ sizeBytes, expiresAt })
      .where(and(eq(s.id, id), eq(s.r2Key, key), eq(s.sizeBytes, 0))).run();
  },
  getObjectForOwner(db: D1Client, id: string, userId: string) {
    return drizzleDb(db).select({ id: s.id, r2_key: s.r2Key }).from(s)
      .where(and(eq(s.id, id), eq(s.userId, userId))).get().then(row => row ?? null);
  },
  listForReview(db: D1Client, timestamp: string, limit: number, offset: number) {
    return drizzleDb(db).select(record).from(s).where(and(gt(s.expiresAt, timestamp), gt(s.sizeBytes, 0)))
      .orderBy(asc(s.createdAt), asc(s.id)).limit(limit).offset(offset).all();
  },
  getForReview(db: D1Client, id: string, timestamp: string) {
    return drizzleDb(db).select(record).from(s).where(and(eq(s.id, id), gt(s.expiresAt, timestamp), gt(s.sizeBytes, 0)))
      .get().then(row => row ?? null);
  },
};
