import { and, count, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { drizzleDb, drizzleReadDb } from "../db";
import { repositories, syncTokens } from "../schema";
import type { D1Client } from "../types";

export const SyncTokenRepository = {
  create(db: D1Client, row: Required<typeof syncTokens.$inferInsert>, limit: number) {
    const q = drizzleDb(db);
    const total = q.select({ count: count() }).from(syncTokens)
      .where(and(eq(syncTokens.repositoryId, row.repositoryId), eq(syncTokens.userId, row.userId)));
    return q.insert(syncTokens).select(sql`select ${row.id}, ${row.userId}, ${row.repositoryId}, ${row.printerId}, ${row.name},
      ${row.tokenHash}, ${row.tokenPrefix}, ${row.scopesJson}, ${row.lastUsedAt}, ${row.expiresAt}, ${row.createdAt}
      where (${total}) < ${limit}`).run();
  },
  remove(db: D1Client, id: string, repositoryId: string, userId: string) {
    return drizzleDb(db).delete(syncTokens).where(and(eq(syncTokens.id, id), eq(syncTokens.repositoryId, repositoryId), eq(syncTokens.userId, userId))).run();
  },
  recordActivity(db: D1Client, id: string, timestamp: string, cutoff: string) {
    return drizzleDb(db).update(syncTokens).set({ lastUsedAt: timestamp }).where(and(eq(syncTokens.id, id),
      or(isNull(syncTokens.lastUsedAt), lte(syncTokens.lastUsedAt, cutoff)))).run();
  },
  bindLegacyPrinter(db: D1Client, id: string, printerId: string) {
    return drizzleDb(db).update(syncTokens).set({ printerId }).where(and(eq(syncTokens.id, id), isNull(syncTokens.printerId))).run();
  },
  listForRepository(db: D1Client, userId: string, repositoryId: string) {
    // Credential hashes stay out of the management/listing projection.
    return drizzleReadDb(db).select({
      id: syncTokens.id,
      name: syncTokens.name,
      printer_id: syncTokens.printerId,
      token_prefix: syncTokens.tokenPrefix,
      scopes_json: syncTokens.scopesJson,
      last_used_at: syncTokens.lastUsedAt,
      expires_at: syncTokens.expiresAt,
      created_at: syncTokens.createdAt,
    }).from(syncTokens)
      .where(and(eq(syncTokens.repositoryId, repositoryId), eq(syncTokens.userId, userId)))
      .orderBy(desc(syncTokens.createdAt)).all();
  },

  countForRepository(db: D1Client, userId: string, repositoryId: string) {
    return drizzleReadDb(db).select({ count: count() }).from(syncTokens)
      .where(and(eq(syncTokens.repositoryId, repositoryId), eq(syncTokens.userId, userId)))
      .get().then(row => row ?? null);
  },

  getAuthenticationContext(db: D1Client, tokenHash: string, repositoryId: string) {
    // Authentication uses the caller's primary session so revocations and
    // printer bindings are visible before the guarded activity update.
    return drizzleReadDb(db).select({
      id: syncTokens.id,
      user_id: syncTokens.userId,
      printer_id: syncTokens.printerId,
      scopes_json: syncTokens.scopesJson,
      expires_at: syncTokens.expiresAt,
      last_used_at: syncTokens.lastUsedAt,
      token_name: syncTokens.name,
      repository_id: repositories.id,
      name: repositories.name,
      title: repositories.title,
      latest_version_id: repositories.latestVersionId,
      created_at: repositories.createdAt,
      updated_at: repositories.updatedAt,
    }).from(syncTokens).innerJoin(repositories, eq(repositories.id, syncTokens.repositoryId))
      .where(and(eq(syncTokens.tokenHash, tokenHash), eq(syncTokens.repositoryId, repositoryId)))
      .get().then(row => row ?? null);
  },
};
