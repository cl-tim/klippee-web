import { sql } from "drizzle-orm";
import { publicPackages } from "./schema";
import { scanPublicConfigFiles } from "../src/safety";
import { deleteCanonicalBlobWriteLeaseQuery } from "./blobBudget";
import { drizzleDb, writeDb, type DrizzleWriteBatch } from "./db";
import { deleteDefaultPublicPackageCache } from "./packageCatalog";
import { PrinterRepository } from "./repositories/PrinterRepository";
import { PublicPackageRepository } from "./repositories/PublicPackageRepository";
import { PrivatePackageRepository } from "./repositories/PrivatePackageRepository";
import { printerHasPackage, scrubPrinterSecretValueStatements, secretVariableJsonPaths } from "./packageSecrets";
import { loadStoredConfigPackage, storeConfigPackageJson, variableDefinitionsFromStored } from "./packageStorage";
import { variableSchemaFromFiles } from "./packageVariables";
import { loadRepositoryFiles } from "./repositoryFiles";
import type { Env } from "./types";
import { nowIso } from "./util";
import { publicPackageForPublish, sanitizePublicPackageVariables } from "./validation";

// Both successful writes and error reports must still refer to the same opted-in
// listing and currently applied version. Disabling, rebinding, manual publishing,
// or editing listing metadata while blobs load wins over this request.
/** Called only after a physical printer confirms an apply or capture, or the
 * owner explicitly enables/retries automatic updates. Never reads draft files. */
export async function updateAutomaticPublications(
  env: Env,
  userId: string,
  repositoryId: string,
  printerId: string | null | undefined,
  onlyListingId?: string,
) {
  if (!printerId) return;
  const db = writeDb(env);
  const rows = await PublicPackageRepository.listAutomaticPublications(db, userId, repositoryId, printerId, onlyListingId);
  for (const row of rows) {
    const applied = await PrinterRepository.getAppliedVersion(db, userId, printerId, repositoryId);
    if (!applied || applied.id === row.approved_version_id) continue;
    const snapshot = { id: row.id, userId, printerId, repositoryId, packageJson: row.package_json,
      updatedAt: row.updated_at, versionId: applied.id };
    const recordError = (message: string) => PublicPackageRepository.recordAutomaticError(db, snapshot, message);
    try {
      // Retain the public title, description, tags and URL. Mutable private
      // package metadata is not an authority for an existing public listing.
      const previous = await loadStoredConfigPackage(env, row.package_json);
      const files = await loadRepositoryFiles(env, applied.files_json);
      if (!previous || !files) {
        await recordError("Automatic update could not load the applied configuration. Retry or republish manually.");
        continue;
      }
      const published = publicPackageForPublish({ ...previous, files });
      const privateMetadata = await PrivatePackageRepository.getOwnedMetadata(db, userId, row.source_package_id);
      const privateSecretNames = new Set(variableDefinitionsFromStored(privateMetadata?.package_json ?? "{}")
        .filter((variable) => variable.secret || variable.type === "secret").map((variable) => variable.name));
      const pkg = {
        ...published,
        // Private definitions may tighten secrecy, but their descriptions and
        // examples must never be copied into a public listing automatically.
        variables: sanitizePublicPackageVariables(variableSchemaFromFiles(published.files, published.variables)
          .map((variable) => privateSecretNames.has(variable.name) ? { ...variable, secret: true } : variable)),
      };
      const findings = scanPublicConfigFiles(pkg.files);
      // Opt-in covers the usual heater/motion/pin review hints. Secrets,
      // identities, missing includes and other specific findings need review.
      if (!pkg.files.length || findings.some((finding) => finding.severity === "block"
        || (finding.kind !== "generic" && finding.category !== "template-variable"))) {
        await recordError("Automatic update needs review: resolve the safety findings or approve and republish manually.");
        continue;
      }
      const stored = await storeConfigPackageJson(env, userId, pkg);
      const timestamp = nowIso();
      const writes: DrizzleWriteBatch = [PublicPackageRepository.automaticUpdateQuery(db, snapshot, stored.packageJson, timestamp)];
      writes.push(...scrubPrinterSecretValueStatements(db, secretVariableJsonPaths(
        pkg.variables.filter((variable) => variable.secret || variable.type === "secret").map((variable) => variable.name),
      ), sql`${printerHasPackage(row.slug)} and exists (select 1 from ${publicPackages}
        where ${publicPackages.id} = ${row.id} and ${publicPackages.userId} = ${userId}
          and ${publicPackages.packageJson} = ${stored.packageJson} and ${publicPackages.approvedVersionId} = ${applied.id})`, timestamp));
      writes.push(deleteCanonicalBlobWriteLeaseQuery(db, stored.leaseId));
      const [updated] = await drizzleDb(db).batch(writes);
      if ((updated.meta.changes ?? 0) > 0) await deleteDefaultPublicPackageCache(env);
    } catch {
      // A public update must never undo or misreport a successful printer apply.
      await recordError("Automatic update to Shared Configs failed. Retry or republish manually.");
    }
  }
}

/** Keep publication failures separate from the physical sync response. */
export async function tryUpdateAutomaticPublications(
  env: Env, userId: string, repositoryId: string, printerId: string | null | undefined,
) {
  try {
    await updateAutomaticPublications(env, userId, repositoryId, printerId);
  } catch {
    console.error(JSON.stringify({ event: "automatic_publication_failed", printerId, repositoryId }));
  }
}
