import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { drizzleDb, drizzleReadDb } from "../db";
import { orcaCaptureGrants as grants, orcaSetups } from "../schema";
import type { D1Client } from "../types";

export const OrcaSetupRepository = {
  create(db: D1Client, input: { id: string; userId: string; tokenHash: string; summaryJson: string; snapshotJson: string; createdAt: string; timestamp: string; limit: number }) {
    const q = drizzleDb(db);
    const total = q.select({ count: count() }).from(orcaSetups).where(eq(orcaSetups.userId, input.userId));
    return q.insert(orcaSetups).select(q.select({
      id: grants.id, userId: grants.userId, printerId: grants.printerId,
      summaryJson: sql<string>`${input.summaryJson}`.as("summary_json"), snapshotJson: sql<string>`${input.snapshotJson}`.as("snapshot_json"), createdAt: sql<string>`${input.createdAt}`.as("created_at"),
    }).from(grants).where(and(eq(grants.id, input.id), eq(grants.tokenHash, input.tokenHash),
      gt(grants.expiresAt, input.timestamp), sql`(${total}) < ${input.limit}`)))
      .onConflictDoNothing().run();
  },
  remove(db: D1Client, id: string, userId: string) {
    const q = drizzleDb(db);
    return q.batch([
      q.delete(grants).where(and(eq(grants.id, id), eq(grants.userId, userId))),
      q.delete(orcaSetups).where(and(eq(orcaSetups.id, id), eq(orcaSetups.userId, userId))),
    ]);
  },
  getSavedSummary(db: D1Client, id: string, userId: string) {
    return drizzleReadDb(db).select({ summary_json: orcaSetups.summaryJson }).from(orcaSetups)
      .where(and(eq(orcaSetups.id, id), eq(orcaSetups.userId, userId))).get().then(row => row ?? null);
  },

  listForUser(db: D1Client, userId: string, printerId?: string) {
    return drizzleReadDb(db).select({ summary_json: orcaSetups.summaryJson, printer_id: orcaSetups.printerId })
      .from(orcaSetups).where(and(eq(orcaSetups.userId, userId), printerId ? eq(orcaSetups.printerId, printerId) : undefined))
      .orderBy(desc(orcaSetups.createdAt)).all();
  },

  getOwned(db: D1Client, id: string, userId: string) {
    return drizzleReadDb(db).select({
      summary_json: orcaSetups.summaryJson, snapshot_json: orcaSetups.snapshotJson, printer_id: orcaSetups.printerId,
    }).from(orcaSetups).where(and(eq(orcaSetups.id, id), eq(orcaSetups.userId, userId))).get().then(row => row ?? null);
  },
};
