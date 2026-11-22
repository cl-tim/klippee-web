import { and, eq, sql } from "drizzle-orm";
import { drizzleReadDb } from "../db";
import { privatePackages, publicPackages } from "../schema";
import type { D1Client } from "../types";

export const PackageSecretRepository = {
  listBoundDefinitions(db: D1Client, userId: string, packageIds: string[]) {
    const read = drizzleReadDb(db);
    // Bind JSON rather than expanding an IN list: the parameter count stays
    // constant even when a printer has hundreds of package bindings.
    const bindings = read.selectDistinct({
      package_id: sql<string>`value`.as("package_id"),
    }).from(sql`json_each(${JSON.stringify(packageIds)})`)
      .where(sql`type = 'text' and value <> ''`).as("bindings");
    // A raw SQL selection alias is not table-qualified by Drizzle 0.45.
    // Qualify it explicitly because private_packages also has package_id.
    const bindingId = sql<string>`"bindings"."package_id"`;
    const owned = read.select({
      package_id: bindingId, package_json: privatePackages.packageJson,
    }).from(bindings).innerJoin(privatePackages, and(
      eq(privatePackages.userId, userId), eq(privatePackages.packageId, bindingId),
    ));
    const published = read.select({
      package_id: bindingId, package_json: publicPackages.packageJson,
    }).from(bindings).innerJoin(publicPackages, eq(publicPackages.slug, bindingId));
    // Deduplicate IDs, not package bodies. UNION ALL retains both definitions
    // when one binding identifies private and public rows.
    return owned.unionAll(published).all();
  },
};
