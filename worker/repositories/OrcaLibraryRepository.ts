import { and, asc, eq, exists, gt, isNotNull, notExists, sql } from "drizzle-orm";
import { drizzleDb, type DrizzleDb } from "../db";
import {
  orcaCaptureGrants, orcaLibraries, orcaLibraryImports, orcaLibraryNodes, orcaProfilePrinters,
  publicCompanionAssets as a, publicPackages as p,
} from "../schema";
import type { D1Client } from "../types";
import { publicCompanionAssetRecord } from "./PublicCompanionAssetRepository";

const summary = (q: DrizzleDb, userId: string) => q.select({ summary_json: orcaLibraries.summaryJson })
  .from(orcaLibraries).where(eq(orcaLibraries.userId, userId));
const nodes = (q: DrizzleDb, userId: string) => q.select({ node_id: orcaLibraryNodes.nodeId, node_json: orcaLibraryNodes.nodeJson })
  .from(orcaLibraryNodes).where(eq(orcaLibraryNodes.userId, userId));
const automaticWhere = (userId: string, onlySourceId?: string) => and(eq(a.userId, userId),
  eq(a.autoUpdateEnabled, 1), isNotNull(a.orcaProfileId), onlySourceId ? eq(a.sourceAssetId, onlySourceId) : undefined);

export const OrcaLibraryRepository = {
  getSummary(db: D1Client, userId: string) {
    return summary(drizzleDb(db), userId).get().then(row => row ?? null);
  },
  getImportReceipt(db: D1Client, id: string, userId: string) {
    return drizzleDb(db).select({ summary_json: orcaLibraryImports.summaryJson }).from(orcaLibraryImports)
      .where(and(eq(orcaLibraryImports.id, id), eq(orcaLibraryImports.userId, userId))).get().then(row => row ?? null);
  },
  getCurrentImport(db: D1Client, userId: string) {
    return drizzleDb(db).select({ import_id: orcaLibraries.importId }).from(orcaLibraries)
      .where(eq(orcaLibraries.userId, userId)).get().then(row => row ?? null);
  },
  getView(db: D1Client, userId: string) {
    const q = drizzleDb(db);
    return q.batch([
      summary(q, userId),
      q.select({
        id: orcaLibraryNodes.nodeId,
        parentId: sql<string | null>`json_extract(${orcaLibraryNodes.nodeJson}, '$.parent')`,
        nozzle: sql<string | null>`json_extract(${orcaLibraryNodes.nodeJson}, '$.saved.nozzle_diameter')`,
        compatiblePrinters: sql<string | null>`json_extract(${orcaLibraryNodes.nodeJson}, '$.saved.compatible_printers')`,
        compatibilityCondition: sql<string | null>`json_extract(${orcaLibraryNodes.nodeJson}, '$.saved.compatible_printers_condition')`,
        material: sql<string | null>`json_extract(${orcaLibraryNodes.nodeJson}, '$.saved.filament_type')`,
        layerHeight: sql<string | null>`json_extract(${orcaLibraryNodes.nodeJson}, '$.saved.layer_height')`,
        printerModel: sql<string | null>`json_extract(${orcaLibraryNodes.nodeJson}, '$.saved.printer_model')`,
      }).from(orcaLibraryNodes).where(eq(orcaLibraryNodes.userId, userId)),
      q.select({ profile_id: orcaProfilePrinters.profileId, printer_id: orcaProfilePrinters.printerId })
        .from(orcaProfilePrinters).where(eq(orcaProfilePrinters.userId, userId)),
      // D1 batch rows are keyed objects before Drizzle maps them by position.
      // Alias joined columns explicitly so duplicate slug/title names survive.
      q.select({ source_asset_id: a.sourceAssetId, slug: a.slug, auto_update_enabled: a.autoUpdateEnabled,
        auto_update_error: a.autoUpdateError,
        printer_config_slug: sql<string | null>`${p.slug}`.as("printer_config_slug"),
        printer_config_title: sql<string | null>`${p.title}`.as("printer_config_title"),
      }).from(a).leftJoin(p, and(eq(p.id, a.printerConfigId), eq(p.userId, a.userId))).where(eq(a.userId, userId)),
    ]);
  },
  getExportSnapshot(db: D1Client, userId: string) {
    const q = drizzleDb(db);
    return q.batch([
      q.select({ summary_json: orcaLibraries.summaryJson, current_json: orcaLibraries.currentJson })
        .from(orcaLibraries).where(eq(orcaLibraries.userId, userId)),
      nodes(q, userId),
    ]);
  },
  getPublicationCandidate(db: D1Client, userId: string, sourceId: string) {
    const q = drizzleDb(db);
    return q.batch([summary(q, userId), nodes(q, userId),
      q.select(publicCompanionAssetRecord).from(a).where(and(eq(a.userId, userId), eq(a.sourceAssetId, sourceId))),
      q.select({ id: p.id, slug: p.slug, title: p.title }).from(p).where(eq(p.userId, userId)).orderBy(asc(p.title)),
    ]);
  },
  hasAutomaticPublications(db: D1Client, userId: string, onlySourceId?: string) {
    return drizzleDb(db).select({ id: a.id }).from(a).where(automaticWhere(userId, onlySourceId))
      .limit(1).get().then(row => row ?? null);
  },
  getAutomaticSnapshot(db: D1Client, userId: string, onlySourceId?: string) {
    const q = drizzleDb(db);
    return q.batch([summary(q, userId), nodes(q, userId),
      q.select(publicCompanionAssetRecord).from(a).where(automaticWhere(userId, onlySourceId)),
    ]);
  },
  linkPrinter(db: D1Client, userId: string, profileId: string, printerId: string, linked: boolean) {
    const q = drizzleDb(db);
    return linked ? q.insert(orcaProfilePrinters).values({ userId, profileId, printerId }).onConflictDoNothing().run()
      : q.delete(orcaProfilePrinters).where(and(eq(orcaProfilePrinters.userId, userId),
        eq(orcaProfilePrinters.profileId, profileId), eq(orcaProfilePrinters.printerId, printerId))).run();
  },
  saveImport(db: D1Client, input: {
    id: string; userId: string; tokenHash: string; timestamp: string; summaryJson: string;
    currentJson: string; receiptJson: string; nodes: Array<{ id: string; json: string }>;
  }) {
    const q = drizzleDb(db);
    const guard = and(exists(q.select({ id: orcaCaptureGrants.id }).from(orcaCaptureGrants).where(and(
      eq(orcaCaptureGrants.id, input.id), eq(orcaCaptureGrants.userId, input.userId),
      eq(orcaCaptureGrants.tokenHash, input.tokenHash), gt(orcaCaptureGrants.expiresAt, input.timestamp),
    ))), notExists(q.select({ id: orcaLibraryImports.id }).from(orcaLibraryImports).where(eq(orcaLibraryImports.id, input.id))));
    // D1 executes the entire batch atomically. The receipt must remain last:
    // every preceding statement repeats the authorization and replay guard.
    return q.batch([
      q.delete(orcaLibraryNodes).where(and(eq(orcaLibraryNodes.userId, input.userId), guard)),
      ...input.nodes.map(node => q.insert(orcaLibraryNodes).select(sql`select ${input.userId}, ${node.id}, ${node.json} where ${guard}`)),
      q.insert(orcaLibraries).select(sql`select ${input.userId}, ${input.id}, ${input.summaryJson}, ${input.currentJson} where ${guard}`)
        .onConflictDoUpdate({ target: orcaLibraries.userId, set: { importId: input.id, summaryJson: input.summaryJson, currentJson: input.currentJson } }),
      q.insert(orcaLibraryImports).select(sql`select ${input.id}, ${input.userId}, ${input.receiptJson}, ${input.timestamp} where ${guard}`),
    ]);
  },
};
