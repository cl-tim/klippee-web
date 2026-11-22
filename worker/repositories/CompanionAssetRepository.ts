import { and, count, desc, eq, exists, notExists, sql } from "drizzle-orm";
import { drizzleDb, drizzleReadDb } from "../db";
import { maxCompanionAssetsPerUser } from "../storageLimits";
import { companionAssets, privatePackages } from "../schema";
import type { D1Client } from "../types";

export function companionAttachmentSourcesPresent(userId: string, ids: string[]) {
  return sql`not exists (select 1 from json_each(${JSON.stringify(ids)}) expected
    where not exists (select 1 from ${companionAssets} source
      where source.user_id = ${userId} and source.id = expected.value))`;
}

export const CompanionAssetRepository = {
  getDeleteContext(db: D1Client, userId: string, assetId: string) {
    return drizzleReadDb(db).select({ asset_json: companionAssets.assetJson, updated_at: companionAssets.updatedAt })
      .from(companionAssets).where(and(eq(companionAssets.userId, userId), eq(companionAssets.id, assetId)))
      .get().then(row => row ?? null);
  },

  deleteUnused(db: D1Client, userId: string, assetId: string, expected: { updatedAt: string; assetJson: string }) {
    const q = drizzleDb(db), a = companionAssets;
    const attached = q.select({ id: privatePackages.id }).from(privatePackages).where(and(eq(privatePackages.userId, userId),
      sql`exists (select 1 from json_each(case when json_valid(${privatePackages.packageJson})
        then ${privatePackages.packageJson} else '{}' end, '$.companionAssetIds') attachment
        where attachment.type = 'text' and attachment.value = ${assetId})`));
    return q.delete(a).where(and(eq(a.userId, userId), eq(a.id, assetId), eq(a.updatedAt, expected.updatedAt),
      eq(a.assetJson, expected.assetJson), notExists(attached),
    )).returning({ id: a.id }).all();
  },

  listOwnedAttachmentIds(db: D1Client, userId: string, ids: string[]) {
    if (!ids.length) return Promise.resolve<{ id: string }[]>([]);
    return drizzleReadDb(db).select({ id: companionAssets.id }).from(companionAssets).where(and(
      eq(companionAssets.userId, userId), sql`${companionAssets.id} in (select value from json_each(${JSON.stringify(ids)}) where type = 'text')`,
    )).all();
  },
  save(db: D1Client, r: Required<typeof companionAssets.$inferInsert>, expectedAssetJson?: string) {
    const q = drizzleDb(db), a = companionAssets;
    const existing = q.select({ id: a.id }).from(a).where(and(eq(a.userId, r.userId), eq(a.id, r.id)));
    const total = q.select({ count: count() }).from(a).where(eq(a.userId, r.userId));
    const unchanged = expectedAssetJson === undefined ? sql`1` : exists(q.select({ id: a.id }).from(a)
      .where(and(eq(a.userId, r.userId), eq(a.id, r.id), eq(a.assetJson, expectedAssetJson))));
    return q.insert(a).select(sql`select ${r.id}, ${r.userId}, ${r.kind}, ${r.title}, ${r.assetJson}, ${r.createdAt}, ${r.updatedAt}
      where (${exists(existing)} or (${total}) < ${maxCompanionAssetsPerUser}) and ${unchanged}`)
      .onConflictDoUpdate({ target: [a.userId, a.id], set: {
        kind: r.kind, title: r.title, assetJson: r.assetJson, updatedAt: r.updatedAt,
      } }).run();
  },
  listForUser(db: D1Client, userId: string) {
    return drizzleReadDb(db).select({
      asset_json: companionAssets.assetJson,
      created_at: companionAssets.createdAt,
      updated_at: companionAssets.updatedAt,
    }).from(companionAssets).where(eq(companionAssets.userId, userId))
      .orderBy(desc(companionAssets.updatedAt)).all();
  },

  getOwned(db: D1Client, userId: string, assetId: string) {
    return drizzleReadDb(db).select({ asset_json: companionAssets.assetJson }).from(companionAssets)
      .where(and(eq(companionAssets.userId, userId), eq(companionAssets.id, assetId)))
      .get().then(row => row ?? null);
  },

  getSaveContext(db: D1Client, userId: string, assetId: string) {
    return drizzleReadDb(db).select({
      asset_json: companionAssets.assetJson,
      created_at: companionAssets.createdAt,
    }).from(companionAssets)
      .where(and(eq(companionAssets.userId, userId), eq(companionAssets.id, assetId)))
      .get().then(row => row ?? null);
  },

  countForUser(db: D1Client, userId: string) {
    return drizzleReadDb(db).select({ count: count() }).from(companionAssets)
      .where(eq(companionAssets.userId, userId)).get().then(row => row ?? null);
  },
};
