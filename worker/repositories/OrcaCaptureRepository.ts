import { and, count, eq, exists, gt, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { drizzleDb, drizzleReadDb } from "../db";
import { orcaCaptureGrants, orcaDevices, orcaLibraryImports, physicalPrinters } from "../schema";
import type { D1Client } from "../types";

export const OrcaCaptureRepository = {
  async pruneExpired(db: D1Client, userId: string, timestamp: string) {
    const q = drizzleDb(db);
    await q.delete(orcaCaptureGrants).where(and(eq(orcaCaptureGrants.userId, userId), lte(orcaCaptureGrants.expiresAt, timestamp))).run();
    await q.delete(orcaLibraryImports).where(and(eq(orcaLibraryImports.userId, userId), notExists(
      q.select({ id: orcaCaptureGrants.id }).from(orcaCaptureGrants).where(eq(orcaCaptureGrants.id, orcaLibraryImports.id)),
    ))).run();
  },
  createGrant(db: D1Client, input: { id: string; userId: string; printerId: string | null; tokenHash: string; expiresAt: string; scope: string }) {
    const q = drizzleDb(db);
    const total = q.select({ count: count() }).from(orcaCaptureGrants)
      .where(and(eq(orcaCaptureGrants.userId, input.userId), isNull(orcaCaptureGrants.deviceId)));
    return q.insert(orcaCaptureGrants).select(sql`select ${input.id}, ${input.userId}, ${input.printerId},
      ${input.tokenHash}, ${input.expiresAt}, ${input.scope}, NULL where (${total}) < 5`).run();
  },
  revokeConnection(db: D1Client, userId: string, id: string) {
    const q = drizzleDb(db);
    return q.batch([
      q.delete(orcaCaptureGrants).where(and(eq(orcaCaptureGrants.id, id), eq(orcaCaptureGrants.userId, userId))),
      q.delete(orcaDevices).where(and(eq(orcaDevices.id, id), eq(orcaDevices.userId, userId))),
    ]);
  },
  getGrant(db: D1Client, tokenHash: string, timestamp: string) {
    const read = drizzleReadDb(db);
    const enabledDevice = read.select({ id: orcaDevices.id }).from(orcaDevices).where(and(
      eq(orcaDevices.id, orcaCaptureGrants.deviceId),
      eq(orcaDevices.userId, orcaCaptureGrants.userId),
      eq(orcaDevices.uploadsEnabled, 1),
    ));
    return read.select({
      id: orcaCaptureGrants.id,
      user_id: orcaCaptureGrants.userId,
      printer_id: orcaCaptureGrants.printerId,
      name: physicalPrinters.name,
      expires_at: orcaCaptureGrants.expiresAt,
      scope: orcaCaptureGrants.scope,
    }).from(orcaCaptureGrants).leftJoin(physicalPrinters, and(
      eq(physicalPrinters.id, orcaCaptureGrants.printerId), eq(physicalPrinters.userId, orcaCaptureGrants.userId),
    )).where(and(
      eq(orcaCaptureGrants.tokenHash, tokenHash), gt(orcaCaptureGrants.expiresAt, timestamp),
      or(isNull(orcaCaptureGrants.deviceId), exists(enabledDevice)),
    )).get().then(row => row ?? null);
  },

  getReviewedUpload(db: D1Client, id: string, userId: string, tokenHash: string, scope: string, deviceId: string) {
    return drizzleReadDb(db).select({ expires_at: orcaCaptureGrants.expiresAt }).from(orcaCaptureGrants)
      .where(and(eq(orcaCaptureGrants.id, id), eq(orcaCaptureGrants.userId, userId),
        eq(orcaCaptureGrants.tokenHash, tokenHash), eq(orcaCaptureGrants.scope, scope), eq(orcaCaptureGrants.deviceId, deviceId)))
      .get().then(row => row ?? null);
  },
};
