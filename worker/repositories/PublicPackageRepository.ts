import { and, asc, eq, exists, or, sql } from "drizzle-orm";
import { drizzleDb, drizzleReadDb, type DrizzleDb } from "../db";
import { physicalPrinters, publicPackages as p, repositoryVersions } from "../schema";
import type { D1Client } from "../types";

const snapshotRow = {
  slug: p.slug,
  package_json: p.packageJson,
  repository_id: p.repositoryId,
  printer_id: p.printerId,
  approved_version_id: p.approvedVersionId,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
  published_at: p.publishedAt,
};

function ownedListing(userId: string, id: string) {
  return and(eq(p.userId, userId), or(eq(p.slug, id), eq(p.sourcePackageId, id)));
}

type AutomaticSnapshot = {
  id: string; userId: string; printerId: string; repositoryId: string; packageJson: string; updatedAt: string; versionId: string;
};
function automaticGuard(q: DrizzleDb, s: AutomaticSnapshot) {
  const applied = q.select({ id: physicalPrinters.id }).from(physicalPrinters).innerJoin(repositoryVersions, and(
    eq(repositoryVersions.repositoryId, physicalPrinters.repositoryId), eq(repositoryVersions.versionNumber, physicalPrinters.appliedVersionId),
  )).where(and(eq(physicalPrinters.id, p.printerId), eq(physicalPrinters.userId, p.userId),
    eq(physicalPrinters.repositoryId, p.repositoryId), eq(repositoryVersions.id, s.versionId)));
  return and(eq(p.id, s.id), eq(p.userId, s.userId), eq(p.printerId, s.printerId), eq(p.repositoryId, s.repositoryId),
    eq(p.autoUpdateEnabled, 1), eq(p.packageJson, s.packageJson), eq(p.updatedAt, s.updatedAt), exists(applied));
}

// Public browsing and owner read-modify-write flows retain the caller's session.
export const PublicPackageRepository = {
  automaticUpdateQuery(db: D1Client, snapshot: AutomaticSnapshot, packageJson: string, timestamp: string) {
    const q = drizzleDb(db);
    return q.update(p).set({ packageJson, approvedVersionId: snapshot.versionId, updatedAt: timestamp,
      publishedAt: timestamp, autoUpdateError: null }).where(automaticGuard(q, snapshot));
  },
  recordAutomaticError(db: D1Client, snapshot: AutomaticSnapshot, autoUpdateError: string) {
    const q = drizzleDb(db);
    return q.update(p).set({ autoUpdateError }).where(automaticGuard(q, snapshot)).run();
  },
  setAutoUpdate(db: D1Client, input: {
    id: string; userId: string; printerId: string | null; repositoryId: string | null; enabled: boolean; timestamp: string;
  }) {
    const q = drizzleDb(db);
    const bound = q.select({ id: physicalPrinters.id }).from(physicalPrinters).where(and(eq(physicalPrinters.id, p.printerId),
      eq(physicalPrinters.userId, p.userId), eq(physicalPrinters.repositoryId, p.repositoryId)));
    return q.update(p).set({ autoUpdateEnabled: input.enabled ? 1 : 0, autoUpdateError: null, updatedAt: input.timestamp })
      .where(and(eq(p.id, input.id), eq(p.userId, input.userId), sql`${p.printerId} is ${input.printerId}`,
        sql`${p.repositoryId} is ${input.repositoryId}`, input.enabled ? exists(bound) : undefined)).run();
  },
  recordSettingFailure(db: D1Client, input: {
    id: string; userId: string; printerId: string | null; repositoryId: string | null; timestamp: string; error: string;
  }) {
    return drizzleDb(db).update(p).set({ autoUpdateError: input.error }).where(and(eq(p.id, input.id), eq(p.userId, input.userId),
      eq(p.autoUpdateEnabled, 1), eq(p.updatedAt, input.timestamp), sql`${p.printerId} is ${input.printerId}`,
      sql`${p.repositoryId} is ${input.repositoryId}`)).run();
  },
  findApprovedReference(db: D1Client, repositoryId: string, versionId: string) {
    return drizzleReadDb(db).select({ id: p.id }).from(p)
      .where(and(eq(p.repositoryId, repositoryId), eq(p.approvedVersionId, versionId))).limit(1).get().then(row => row ?? null);
  },
  getOwnedConfig(db: D1Client, userId: string, id: string, bySlug: boolean) {
    return drizzleReadDb(db).select({ id: p.id, slug: p.slug, title: p.title }).from(p)
      .where(and(eq(p.userId, userId), bySlug ? eq(p.slug, id) : eq(p.id, id))).get().then(row => row ?? null);
  },
  listAutomaticPublications(db: D1Client, userId: string, repositoryId: string, printerId: string, onlyListingId?: string) {
    return drizzleReadDb(db).select({
      id: p.id, slug: p.slug, source_package_id: p.sourcePackageId,
      package_json: p.packageJson, updated_at: p.updatedAt, approved_version_id: p.approvedVersionId,
    }).from(p).where(and(
      eq(p.userId, userId), eq(p.repositoryId, repositoryId), eq(p.printerId, printerId), eq(p.autoUpdateEnabled, 1),
      onlyListingId ? eq(p.id, onlyListingId) : undefined,
    )).all();
  },

  getPublic(db: D1Client, id: string) {
    return drizzleReadDb(db).select({ user_id: p.userId, ...snapshotRow }).from(p)
      .where(or(eq(p.slug, id), eq(p.name, id))).get().then(row => row ?? null);
  },

  getExistingPublication(db: D1Client, userId: string, packageId: string) {
    return drizzleReadDb(db).select({
      created_at: p.createdAt, id: p.id, printer_id: p.printerId, repository_id: p.repositoryId, slug: p.slug,
    }).from(p).where(and(eq(p.userId, userId), eq(p.sourcePackageId, packageId)))
      .orderBy(asc(p.createdAt)).limit(1).get().then(row => row ?? null);
  },

  getOwnedForEdit(db: D1Client, userId: string, id: string) {
    return drizzleReadDb(db).select({ id: p.id, source_package_id: p.sourcePackageId, ...snapshotRow })
      .from(p).where(ownedListing(userId, id)).limit(1).get().then(row => row ?? null);
  },

  getAutoUpdateContext(db: D1Client, userId: string, id: string) {
    return drizzleReadDb(db).select({ id: p.id, printer_id: p.printerId, repository_id: p.repositoryId })
      .from(p).where(ownedListing(userId, id)).limit(1).get().then(row => row ?? null);
  },

  getApprovalStatus(db: D1Client, userId: string, id: string) {
    return drizzleReadDb(db).select({
      approved_version_id: p.approvedVersionId,
      printer_id: p.printerId,
      repository_id: p.repositoryId,
      auto_update_enabled: p.autoUpdateEnabled,
      auto_update_error: p.autoUpdateError,
      current_applied_version_id: repositoryVersions.id,
    }).from(p).leftJoin(physicalPrinters, and(
      eq(physicalPrinters.id, p.printerId),
      eq(physicalPrinters.repositoryId, p.repositoryId),
      eq(physicalPrinters.userId, p.userId),
    )).leftJoin(repositoryVersions, and(
      eq(repositoryVersions.repositoryId, physicalPrinters.repositoryId),
      eq(repositoryVersions.versionNumber, physicalPrinters.appliedVersionId),
    )).where(ownedListing(userId, id)).limit(1).get().then(row => row ?? null);
  },
};
