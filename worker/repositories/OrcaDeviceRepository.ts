import { and, count, desc, eq, gt, isNotNull, notExists, sql } from "drizzle-orm";
import { drizzleDb, drizzleReadDb } from "../db";
import { orcaCaptureGrants as grants, orcaDevices, orcaLibraryImports, orcaSetups } from "../schema";
import type { D1Client } from "../types";

export const OrcaDeviceRepository = {
  pair(db: D1Client, input: { id: string; userId: string; tokenHash: string; grantHash: string; timestamp: string }) {
    const q = drizzleDb(db);
    const total = q.select({ count: count() }).from(orcaDevices).where(eq(orcaDevices.userId, input.userId));
    return q.insert(orcaDevices).select(q.select({
      id: grants.id, userId: grants.userId, tokenHash: sql<string>`${input.tokenHash}`.as("token_hash"),
      createdAt: sql<string>`${input.timestamp}`.as("created_at"), lastUsedAt: sql<string>`${input.timestamp}`.as("last_used_at"), uploadsEnabled: sql<number>`0`.as("uploads_enabled"),
    }).from(grants).where(and(eq(grants.id, input.id), eq(grants.tokenHash, input.grantHash),
      eq(grants.scope, "pair"), gt(grants.expiresAt, input.timestamp), sql`(${total}) < 10`)))
      .onConflictDoNothing({ target: orcaDevices.id }).run();
  },
  recordActivity(db: D1Client, id: string, timestamp: string) {
    return drizzleDb(db).update(orcaDevices).set({ lastUsedAt: timestamp }).where(eq(orcaDevices.id, id)).run();
  },
  setUploads(db: D1Client, userId: string, id: string, enabled: boolean) {
    const q = drizzleDb(db);
    return q.batch([
      q.update(orcaDevices).set({ uploadsEnabled: Number(enabled) }).where(and(eq(orcaDevices.id, id), eq(orcaDevices.userId, userId))),
      q.delete(grants).where(and(eq(grants.deviceId, id), eq(grants.userId, userId))),
    ]);
  },
  createUpload(db: D1Client, input: { id: string; userId: string; deviceId: string; deviceHash: string; tokenHash: string; scope: string; expiresAt: string }) {
    const q = drizzleDb(db);
    const open = q.select({ count: count() }).from(grants).where(and(eq(grants.userId, input.userId), isNotNull(grants.deviceId),
      notExists(q.select({ id: orcaSetups.id }).from(orcaSetups).where(eq(orcaSetups.id, grants.id))),
      notExists(q.select({ id: orcaLibraryImports.id }).from(orcaLibraryImports).where(eq(orcaLibraryImports.id, grants.id))),
    ));
    return q.insert(grants).select(q.select({
      id: sql<string>`${input.id}`.as("id"), userId: orcaDevices.userId, printerId: sql<null>`NULL`.as("printer_id"),
      tokenHash: sql<string>`${input.tokenHash}`.as("token_hash"), expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
      scope: sql<string>`${input.scope}`.as("scope"), deviceId: orcaDevices.id,
    }).from(orcaDevices).where(and(eq(orcaDevices.id, input.deviceId), eq(orcaDevices.userId, input.userId),
      eq(orcaDevices.tokenHash, input.deviceHash), eq(orcaDevices.uploadsEnabled, 1), sql`(${open}) < 5`)))
      .onConflictDoNothing({ target: grants.id }).run();
  },
  revoke(db: D1Client, id: string, userId?: string) {
    const q = drizzleDb(db);
    return q.batch([
      q.delete(orcaDevices).where(and(eq(orcaDevices.id, id), userId ? eq(orcaDevices.userId, userId) : undefined)),
      q.delete(grants).where(and(eq(grants.id, id), eq(grants.scope, "pair"), userId ? eq(grants.userId, userId) : undefined)),
    ]);
  },
  getPaired(db: D1Client, id: string, userId: string, tokenHash: string) {
    return drizzleReadDb(db).select({ id: orcaDevices.id }).from(orcaDevices)
      .where(and(eq(orcaDevices.id, id), eq(orcaDevices.userId, userId), eq(orcaDevices.tokenHash, tokenHash)))
      .get().then(row => row ?? null);
  },

  getAuthenticationContext(db: D1Client, tokenHash: string) {
    return drizzleReadDb(db).select({
      id: orcaDevices.id, user_id: orcaDevices.userId, uploads_enabled: orcaDevices.uploadsEnabled,
    }).from(orcaDevices).where(eq(orcaDevices.tokenHash, tokenHash)).get().then(row => row ?? null);
  },

  listForUser(db: D1Client, userId: string) {
    return drizzleReadDb(db).select({
      id: orcaDevices.id, createdAt: orcaDevices.createdAt, lastUsedAt: orcaDevices.lastUsedAt, uploadsEnabled: orcaDevices.uploadsEnabled,
    }).from(orcaDevices).where(eq(orcaDevices.userId, userId)).orderBy(desc(orcaDevices.createdAt)).all();
  },
};
