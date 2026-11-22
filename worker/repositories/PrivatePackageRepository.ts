import { and, count, desc, eq, exists, sql, type SQL } from "drizzle-orm";
import { drizzleDb, drizzleReadDb } from "../db";
import { maxPrivatePackagesPerUser } from "../storageLimits";
import { physicalPrinters, privatePackages, publicPackages } from "../schema";
import type { D1Client } from "../types";

const packageRow = {
  package_json: privatePackages.packageJson,
  created_at: privatePackages.createdAt,
  updated_at: privatePackages.updatedAt,
};

/** Fence a printer bind against deletion of definitions it already consulted. */
export function privateBindingSourcesPresent(userId: string, packageIds: string[]) {
  return sql`not exists (select 1 from json_each(${JSON.stringify(packageIds)}) expected
    where not exists (select 1 from ${privatePackages} source
      where source.user_id = ${userId} and source.package_id = expected.value))`;
}

function boundPrinters(q: Pick<ReturnType<typeof drizzleDb>, "select">, userId: string, packageId: string | typeof privatePackages.packageId) {
  return q.select({ count: count() }).from(physicalPrinters).where(and(eq(physicalPrinters.userId, userId),
    sql`exists (select 1 from json_each(case when json_valid(${physicalPrinters.packageIdsJson})
      then ${physicalPrinters.packageIdsJson} else '[]' end) binding
      where binding.type = 'text' and binding.value = ${packageId})`));
}

// Keep caller-selected sessions for both browsing and publication/save reads.
export const PrivatePackageRepository = {
  listForManagement(db: D1Client, userId: string) {
    const q = drizzleReadDb(db);
    const published = q.select({ count: count() }).from(publicPackages).where(and(
      eq(publicPackages.userId, userId), eq(publicPackages.sourcePackageId, privatePackages.packageId)));
    return q.select({ id: privatePackages.packageId, name: privatePackages.name, title: privatePackages.title,
      updated_at: privatePackages.updatedAt,
      linked_printer_count: sql<number>`(${boundPrinters(q, userId, privatePackages.packageId)})`.mapWith(Number),
      published_listing_count: sql<number>`(${published})`.mapWith(Number),
    }).from(privatePackages).where(eq(privatePackages.userId, userId))
      .orderBy(desc(privatePackages.updatedAt), privatePackages.packageId).all();
  },

  deleteUnused(db: D1Client, userId: string, packageId: string, expected: { updatedAt: string; packageJson: string }) {
    const q = drizzleDb(db);
    return q.delete(privatePackages).where(and(eq(privatePackages.userId, userId), eq(privatePackages.packageId, packageId),
      eq(privatePackages.updatedAt, expected.updatedAt), eq(privatePackages.packageJson, expected.packageJson),
      sql`(${boundPrinters(q, userId, packageId)}) = 0`,
    )).returning({ id: privatePackages.packageId }).all();
  },

  listOwnedBindingIds(db: D1Client, userId: string, packageIds: string[]) {
    if (!packageIds.length) return Promise.resolve<{ id: string }[]>([]);
    return drizzleReadDb(db).select({ id: privatePackages.packageId }).from(privatePackages)
      .where(and(eq(privatePackages.userId, userId), sql`${privatePackages.packageId} in
        (select value from json_each(${JSON.stringify(packageIds)}) where type = 'text')`)).all();
  },
  upsertQuery(db: D1Client, r: Required<typeof privatePackages.$inferInsert>, attachmentGuard: SQL = sql`1`) {
    const q = drizzleDb(db), p = privatePackages;
    const existing = q.select({ id: p.id }).from(p).where(and(eq(p.userId, r.userId), eq(p.packageId, r.packageId)));
    const total = q.select({ count: count() }).from(p).where(eq(p.userId, r.userId));
    return q.insert(p).select(sql`select ${r.id}, ${r.userId}, ${r.packageId}, ${r.name}, ${r.title}, ${r.packageJson},
      ${r.createdAt}, ${r.updatedAt} where (${exists(existing)} or (${total}) < ${maxPrivatePackagesPerUser}) and ${attachmentGuard}`)
      .onConflictDoUpdate({ target: [p.userId, p.packageId], set: {
        name: r.name, title: r.title, packageJson: r.packageJson, updatedAt: r.updatedAt,
      } });
  },
  getOwnedMetadata(db: D1Client, userId: string, packageId: string) {
    return drizzleReadDb(db).select({ package_json: privatePackages.packageJson }).from(privatePackages)
      .where(and(eq(privatePackages.userId, userId), eq(privatePackages.packageId, packageId)))
      .get().then(row => row ?? null);
  },

  listForUser(db: D1Client, userId: string) {
    return drizzleReadDb(db).select(packageRow).from(privatePackages)
      .where(eq(privatePackages.userId, userId)).orderBy(desc(privatePackages.updatedAt)).all();
  },

  getOwned(db: D1Client, userId: string, packageId: string) {
    return drizzleReadDb(db).select(packageRow).from(privatePackages)
      .where(and(eq(privatePackages.userId, userId), eq(privatePackages.packageId, packageId)))
      .limit(1).get().then(row => row ?? null);
  },

  getSaveQuota(db: D1Client, userId: string, packageId: string) {
    const read = drizzleReadDb(db);
    const existing = read.select({ id: privatePackages.id }).from(privatePackages)
      .where(and(eq(privatePackages.userId, userId), eq(privatePackages.packageId, packageId)));
    // An aggregate without GROUP BY returns one row even for an empty library.
    // Keep the existence flag and owner count in the same database statement.
    return read.select({
      existing_package: exists(existing).mapWith(Number),
      package_count: count(),
    }).from(privatePackages).where(eq(privatePackages.userId, userId))
      .get().then(row => row ?? null);
  },
};
