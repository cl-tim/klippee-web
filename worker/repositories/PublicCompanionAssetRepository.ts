import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { drizzleReadDb } from "../db";
import { publicCompanionAssets as a, publicPackages as p } from "../schema";
import type { D1Client } from "../types";

const assetRow = {
  id: a.id,
  source_asset_id: a.sourceAssetId,
  slug: a.slug,
  kind: a.kind,
  title: a.title,
  asset_json: a.assetJson,
  created_at: a.createdAt,
  updated_at: a.updatedAt,
  published_at: a.publishedAt,
};

// Internal publication state; public responses still use explicit projections.
export const publicCompanionAssetRecord = {
  ...assetRow, user_id: a.userId, orca_profile_id: a.orcaProfileId,
  auto_update_enabled: a.autoUpdateEnabled, auto_update_error: a.autoUpdateError,
  auto_update_import_id: a.autoUpdateImportId, printer_config_id: a.printerConfigId,
};

export const PublicCompanionAssetRepository = {
  getOwnedRecord(db: D1Client, userId: string, sourceId: string) {
    return drizzleReadDb(db).select(publicCompanionAssetRecord).from(a)
      .where(and(eq(a.userId, userId), eq(a.sourceAssetId, sourceId))).get().then(row => row ?? null);
  },
  getAutomaticStatus(db: D1Client, userId: string, id: string) {
    return drizzleReadDb(db).select({ auto_update_enabled: a.autoUpdateEnabled, auto_update_error: a.autoUpdateError })
      .from(a).where(and(eq(a.id, id), eq(a.userId, userId))).get().then(row => row ?? null);
  },
  getBySlug(db: D1Client, slug: string) {
    return drizzleReadDb(db).select({
      ...assetRow, printer_config_slug: p.slug, printer_config_title: p.title,
    }).from(a).leftJoin(p, and(eq(p.id, a.printerConfigId), eq(p.userId, a.userId)))
      .where(eq(a.slug, slug)).get().then(row => row ?? null);
  },

  getOwnedSource(db: D1Client, userId: string, sourceId: string) {
    return drizzleReadDb(db).select(assetRow).from(a)
      .where(and(eq(a.userId, userId), eq(a.sourceAssetId, sourceId))).get().then(row => row ?? null);
  },

  listConfigProfiles(db: D1Client, slug: string) {
    return drizzleReadDb(db).select({
      kind: a.kind,
      title: a.title,
      publicSlug: a.slug,
      publishedAt: a.publishedAt,
      description: sql<string | null>`json_extract(${a.assetJson}, '$.description')`,
      tags: sql<string | null>`json_extract(${a.assetJson}, '$.tags')`,
      version: sql<string | null>`json_extract(${a.assetJson}, '$.version')`,
    }).from(a).innerJoin(p, and(eq(p.id, a.printerConfigId), eq(p.userId, a.userId)))
      .where(and(or(eq(p.slug, slug), eq(p.name, slug)), isNotNull(a.orcaProfileId)))
      .orderBy(asc(a.title)).limit(64).all();
  },
};
