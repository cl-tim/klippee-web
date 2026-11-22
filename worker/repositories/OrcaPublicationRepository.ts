import { and, count, eq, exists, notExists, or, sql } from "drizzle-orm";
import { drizzleDb } from "../db";
import { orcaLibraries, publicCompanionAssets as a, publicPackages as p } from "../schema";
import type { D1Client } from "../types";

type ListingSnapshot = { id: string; asset_json: string; updated_at: string; orca_profile_id?: string | null; printer_config_id?: string | null };
type AutomaticChanges = Partial<Pick<typeof a.$inferInsert,
  "assetJson" | "updatedAt" | "publishedAt" | "autoUpdateImportId" | "autoUpdateError">>;

export const OrcaPublicationRepository = {
  publish(db: D1Client, input: {
    row: Required<typeof a.$inferInsert>; importId: string; previous?: ListingSnapshot; limit: number;
  }) {
    const q = drizzleDb(db), r = input.row, previous = input.previous;
    const owned = and(eq(a.userId, r.userId), eq(a.sourceAssetId, r.sourceAssetId));
    const matching = q.select({ id: a.id }).from(a).where(owned);
    const total = q.select({ count: count() }).from(a).where(eq(a.userId, r.userId));
    const guard = and(
      exists(q.select({ userId: orcaLibraries.userId }).from(orcaLibraries)
        .where(and(eq(orcaLibraries.userId, r.userId), eq(orcaLibraries.importId, input.importId)))),
      or(exists(matching), sql`(${total}) < ${input.limit}`),
      or(and(sql`${previous?.asset_json ?? null} is null`, notExists(matching)),
        exists(q.select({ id: a.id }).from(a).where(and(owned,
          eq(a.assetJson, previous?.asset_json ?? ""), eq(a.updatedAt, previous?.updated_at ?? ""))))),
      or(sql`${r.printerConfigId} is null`, exists(q.select({ id: p.id }).from(p)
        .where(and(eq(p.id, r.printerConfigId ?? ""), eq(p.userId, r.userId))))),
    );
    return q.insert(a).select(sql`select ${r.id}, ${r.userId}, ${r.sourceAssetId}, ${r.slug}, ${r.kind}, ${r.title},
      ${r.assetJson}, ${r.createdAt}, ${r.updatedAt}, ${r.publishedAt}, ${r.orcaProfileId}, ${r.autoUpdateEnabled},
      ${r.autoUpdateError}, ${r.autoUpdateImportId}, ${r.printerConfigId} where ${guard}`)
      .onConflictDoUpdate({ target: [a.userId, a.sourceAssetId], set: {
        kind: r.kind, title: r.title, assetJson: r.assetJson, updatedAt: r.updatedAt, publishedAt: r.publishedAt,
        orcaProfileId: r.orcaProfileId, autoUpdateEnabled: r.autoUpdateEnabled, autoUpdateError: null,
        autoUpdateImportId: r.autoUpdateImportId, printerConfigId: r.printerConfigId,
      }, setWhere: and(eq(a.assetJson, previous?.asset_json ?? ""), eq(a.updatedAt, previous?.updated_at ?? "")) }).run();
  },
  updateSettings(db: D1Client, userId: string, previous: ListingSnapshot, input: {
    profileId: string; enabled: boolean; configId: string | null; timestamp: string;
  }) {
    const q = drizzleDb(db);
    return q.update(a).set({ orcaProfileId: input.profileId, autoUpdateEnabled: Number(input.enabled),
      autoUpdateError: null, printerConfigId: input.configId, updatedAt: input.timestamp,
    }).where(and(eq(a.id, previous.id), eq(a.userId, userId), eq(a.assetJson, previous.asset_json), eq(a.updatedAt, previous.updated_at),
      or(sql`${input.configId} is null`, exists(q.select({ id: p.id }).from(p)
        .where(and(eq(p.id, input.configId ?? ""), eq(p.userId, userId))))),
    )).run();
  },
  updateAutomatic(db: D1Client, userId: string, previous: ListingSnapshot, importId: string, changes: AutomaticChanges) {
    const q = drizzleDb(db);
    return q.update(a).set(changes).where(and(eq(a.id, previous.id), eq(a.userId, userId),
      eq(a.assetJson, previous.asset_json), eq(a.updatedAt, previous.updated_at), eq(a.autoUpdateEnabled, 1),
      sql`${a.orcaProfileId} = ${previous.orca_profile_id ?? null}`, sql`${a.printerConfigId} is ${previous.printer_config_id ?? null}`,
      exists(q.select({ userId: orcaLibraries.userId }).from(orcaLibraries)
        .where(and(eq(orcaLibraries.userId, userId), eq(orcaLibraries.importId, importId)))),
    )).run();
  },
  remove(db: D1Client, userId: string, sourceId: string) {
    return drizzleDb(db).delete(a).where(and(eq(a.userId, userId), eq(a.sourceAssetId, sourceId))).run();
  },
};
