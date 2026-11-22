import { and, asc, count, desc, eq, exists, sql } from "drizzle-orm";
import { drizzleDb, drizzleReadDb } from "../db";
import { physicalPrinters, repositories, repositoryVersions } from "../schema";
import type { D1Client } from "../types";

// Preserve the native row shape for existing response and secret filters.
const printerRow = {
  id: physicalPrinters.id,
  user_id: physicalPrinters.userId,
  name: physicalPrinters.name,
  description: physicalPrinters.description,
  make: physicalPrinters.make,
  model: physicalPrinters.model,
  source: physicalPrinters.source,
  definition_json: physicalPrinters.definitionJson,
  package_ids_json: physicalPrinters.packageIdsJson,
  variable_values_json: physicalPrinters.variableValuesJson,
  repository_id: physicalPrinters.repositoryId,
  latest_version_id: physicalPrinters.latestVersionId,
  applied_version_id: physicalPrinters.appliedVersionId,
  known_good_version_id: physicalPrinters.knownGoodVersionId,
  created_at: physicalPrinters.createdAt,
  updated_at: physicalPrinters.updatedAt,
  host_info_json: physicalPrinters.hostInfoJson,
  host_info_updated_at: physicalPrinters.hostInfoUpdatedAt,
  applied_at: physicalPrinters.appliedAt,
};

// The caller supplies its D1 session. In particular, variable reads and
// pre/post-write lookups must stay on the existing first-primary session.
export const PrinterRepository = {
  markAppliedVersion(db: D1Client, input: {
    printerId: string; repositoryId: string; userId: string; versionId: string | null; versionNumber: number; timestamp: string;
  }) {
    const q = drizzleDb(db);
    const latest = q.select({ version: repositoryVersions.versionNumber }).from(repositories)
      .innerJoin(repositoryVersions, eq(repositoryVersions.id, repositories.latestVersionId))
      .where(eq(repositories.id, input.repositoryId));
    const applied = q.select({ id: repositoryVersions.id }).from(repositoryVersions).where(and(
      eq(repositoryVersions.repositoryId, input.repositoryId), sql`${repositoryVersions.id} = ${input.versionId}`,
      eq(repositoryVersions.versionNumber, input.versionNumber)));
    return q.update(physicalPrinters).set({ latestVersionId: sql`coalesce((${latest}), ${physicalPrinters.latestVersionId})`,
      appliedVersionId: input.versionNumber, appliedAt: input.timestamp, updatedAt: input.timestamp,
    }).where(and(eq(physicalPrinters.id, input.printerId), eq(physicalPrinters.repositoryId, input.repositoryId),
      eq(physicalPrinters.userId, input.userId), exists(applied))).run();
  },
  markLatestVersion(db: D1Client, input: {
    printerId: string; repositoryId: string; userId: string; versionNumber: number; timestamp: string;
  }) {
    return drizzleDb(db).update(physicalPrinters).set({ latestVersionId: input.versionNumber, updatedAt: input.timestamp })
      .where(and(eq(physicalPrinters.id, input.printerId), eq(physicalPrinters.repositoryId, input.repositoryId),
        eq(physicalPrinters.userId, input.userId))).run();
  },
  saveHostInfo(db: D1Client, input: {
    printerId: string; repositoryId: string; userId: string; hostInfoJson: string; timestamp: string;
  }) {
    return drizzleDb(db).update(physicalPrinters).set({ hostInfoJson: input.hostInfoJson,
      hostInfoUpdatedAt: input.timestamp, updatedAt: input.timestamp,
    }).where(and(eq(physicalPrinters.id, input.printerId), eq(physicalPrinters.repositoryId, input.repositoryId),
      eq(physicalPrinters.userId, input.userId))).run();
  },
  bindRepository(db: D1Client, printerId: string, userId: string, repositoryId: string, updatedAt: string) {
    return drizzleDb(db).update(physicalPrinters).set({ repositoryId, updatedAt })
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.userId, userId))).run();
  },
  findAppliedReference(db: D1Client, repositoryId: string, versionNumber: number) {
    return drizzleReadDb(db).select({ id: physicalPrinters.id }).from(physicalPrinters)
      .where(and(eq(physicalPrinters.repositoryId, repositoryId), eq(physicalPrinters.appliedVersionId, versionNumber)))
      .limit(1).get().then(row => row ?? null);
  },
  getOwnedId(db: D1Client, printerId: string, userId: string) {
    return drizzleReadDb(db).select({ id: physicalPrinters.id }).from(physicalPrinters)
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.userId, userId)))
      .get().then(row => row ?? null);
  },

  getSyncTarget(db: D1Client, printerId: string, repositoryId: string, userId: string) {
    return drizzleReadDb(db).select(printerRow).from(physicalPrinters)
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.repositoryId, repositoryId), eq(physicalPrinters.userId, userId)))
      .get().then(row => row ?? null);
  },

  getCaptureContext(db: D1Client, printerId: string, repositoryId: string, userId: string) {
    return drizzleReadDb(db).select({
      applied_version_id: physicalPrinters.appliedVersionId,
      package_ids_json: physicalPrinters.packageIdsJson,
      variable_values_json: physicalPrinters.variableValuesJson,
    }).from(physicalPrinters)
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.repositoryId, repositoryId), eq(physicalPrinters.userId, userId)))
      .limit(1).get().then(row => row ?? null);
  },

  getSyncName(db: D1Client, printerId: string, repositoryId: string, userId: string) {
    return drizzleReadDb(db).select({ name: physicalPrinters.name }).from(physicalPrinters)
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.repositoryId, repositoryId), eq(physicalPrinters.userId, userId)))
      .get().then(row => row ?? null);
  },

  listLegacySyncCandidates(db: D1Client, repositoryId: string, userId: string) {
    return drizzleReadDb(db).select({ id: physicalPrinters.id }).from(physicalPrinters)
      .where(and(eq(physicalPrinters.repositoryId, repositoryId), eq(physicalPrinters.userId, userId)))
      .orderBy(asc(physicalPrinters.createdAt)).limit(2).all();
  },

  getSyncTokenBinding(db: D1Client, printerId: string, userId: string) {
    return drizzleReadDb(db).select({ id: physicalPrinters.id, repository_id: physicalPrinters.repositoryId })
      .from(physicalPrinters)
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.userId, userId)))
      .get().then(row => row ?? null);
  },

  getAppliedVersion(db: D1Client, userId: string, printerId: string, repositoryId: string) {
    return drizzleReadDb(db).select({ id: repositoryVersions.id, files_json: repositoryVersions.filesJson })
      .from(physicalPrinters).innerJoin(repositoryVersions, and(
        eq(repositoryVersions.repositoryId, physicalPrinters.repositoryId),
        eq(repositoryVersions.versionNumber, physicalPrinters.appliedVersionId),
      )).where(and(
        eq(physicalPrinters.id, printerId), eq(physicalPrinters.repositoryId, repositoryId), eq(physicalPrinters.userId, userId),
      )).limit(1).get().then(row => row ?? null);
  },

  listForUser(db: D1Client, userId: string) {
    return drizzleReadDb(db).select(printerRow).from(physicalPrinters)
      .where(eq(physicalPrinters.userId, userId)).orderBy(desc(physicalPrinters.updatedAt)).all();
  },

  getOwned(db: D1Client, printerId: string, userId: string) {
    return drizzleReadDb(db).select(printerRow).from(physicalPrinters)
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.userId, userId)))
      .get().then(row => row ?? null);
  },

  getBound(db: D1Client, repositoryId: string, userId: string) {
    return drizzleReadDb(db).select(printerRow).from(physicalPrinters)
      .where(and(eq(physicalPrinters.repositoryId, repositoryId), eq(physicalPrinters.userId, userId)))
      .orderBy(desc(physicalPrinters.updatedAt)).limit(1).get().then(row => row ?? null);
  },

  countForUser(db: D1Client, userId: string) {
    return drizzleReadDb(db).select({ count: count() }).from(physicalPrinters)
      .where(eq(physicalPrinters.userId, userId)).get().then(row => row ?? null);
  },

  getUpsertContext(db: D1Client, printerId: string, userId: string) {
    return drizzleReadDb(db).select({
      created_at: physicalPrinters.createdAt,
      repository_id: physicalPrinters.repositoryId,
    }).from(physicalPrinters)
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.userId, userId)))
      .get().then(row => row ?? null);
  },

  getVariableValues(db: D1Client, printerId: string, userId: string) {
    return drizzleReadDb(db).select({
      package_ids_json: physicalPrinters.packageIdsJson,
      variable_values_json: physicalPrinters.variableValuesJson,
    }).from(physicalPrinters)
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.userId, userId)))
      .get().then(row => row ?? null);
  },

  getPublicationCandidate(db: D1Client, printerId: string, userId: string) {
    return drizzleReadDb(db).select({
      applied_at: physicalPrinters.appliedAt,
      applied_version_id: physicalPrinters.appliedVersionId,
      repository_id: physicalPrinters.repositoryId,
      files_json: repositoryVersions.filesJson,
      version_id: repositoryVersions.id,
      version_number: repositoryVersions.versionNumber,
    }).from(physicalPrinters)
      .leftJoin(repositoryVersions, and(
        eq(repositoryVersions.repositoryId, physicalPrinters.repositoryId),
        eq(repositoryVersions.versionNumber, physicalPrinters.appliedVersionId),
      ))
      .where(and(eq(physicalPrinters.id, printerId), eq(physicalPrinters.userId, userId)))
      .limit(1).get().then(row => row ?? null);
  },
};
