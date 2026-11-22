import { packages } from "../src/data";
import { sql, type SQL } from "drizzle-orm";
import { maxD1JsonRemovePathsPerStatement } from "./constants";
import { PackageSecretRepository } from "./repositories/PackageSecretRepository";
import { drizzleDb, readDb, type DrizzleWriteQuery } from "./db";
import { physicalPrinters } from "./schema";
import { variableDefinitionsFromStored } from "./packageStorage";
import type { D1Client, Env } from "./types";
import { parseJsonFallback } from "./util";

// Stored printer variable keys use the same grammar as template markers.
// Restricting names here also keeps every bound SQLite JSON path valid.
const secretVariableNamePattern = /^[a-z][a-z0-9_]*$/;

/**
 * Maps secret variable names to the deduplicated SQLite JSON paths (`$.name`)
 * used to scrub stored printer values. Names outside the template-marker
 * grammar are dropped so no caller-controlled text can alter a JSON path.
 */
export function secretVariableJsonPaths(names: Iterable<string>): string[] {
  return Array.from(new Set(
    Array.from(names)
      .filter((name) => secretVariableNamePattern.test(name))
      .map((name) => `$.${name}`),
  ));
}

/**
 * Builds the chunked `json_remove` UPDATE statements that scrub secret values
 * from `printers.variable_values_json`. Each statement stays comfortably below
 * D1's bound-parameter ceiling (`maxD1JsonRemovePathsPerStatement` paths per
 * statement); callers batch all returned statements so the scrub stays atomic
 * with the surrounding write. The caller supplies a typed SQL predicate so
 * its ownership and transactional guards remain in each update.
 */
export function scrubPrinterSecretValueStatements(
  db: D1Client,
  paths: string[],
  where: SQL,
  setUpdatedAtTo?: string,
): DrizzleWriteQuery[] {
  const statements: DrizzleWriteQuery[] = [];
  const q = drizzleDb(db);
  for (let offset = 0; offset < paths.length; offset += maxD1JsonRemovePathsPerStatement) {
    const pathChunk = paths.slice(offset, offset + maxD1JsonRemovePathsPerStatement);
    statements.push(q.update(physicalPrinters).set({
      variableValuesJson: sql`case when json_valid(${physicalPrinters.variableValuesJson})
        then json_remove(${physicalPrinters.variableValuesJson}, ${sql.join(pathChunk.map(path => sql`${path}`), sql`, `)})
        else '{}' end`,
      ...(setUpdatedAtTo === undefined ? {} : { updatedAt: setUpdatedAtTo }),
    }).where(where));
  }
  return statements;
}

export function printerHasPackage(packageId: string) {
  return sql`exists (select 1 from json_each(case when json_valid(${physicalPrinters.packageIdsJson})
    then ${physicalPrinters.packageIdsJson} else '[]' end) binding where binding.value = ${packageId})`;
}

function addSecretDefinitions(names: Set<string>, packageJson: string) {
  for (const variable of variableDefinitionsFromStored(packageJson)) {
    if (variable.secret || variable.type === "secret") {
      names.add(variable.name);
    }
  }
}

function normalizedPackageIds(packageIds: string[]) {
  return Array.from(new Set(packageIds.filter((id) => typeof id === "string" && id.length > 0)));
}

export function parsePrinterPackageIds(packageIdsJson: string) {
  const parsed = parseJsonFallback<unknown>(packageIdsJson, []);
  return Array.isArray(parsed)
    ? normalizedPackageIds(parsed.filter((value): value is string => typeof value === "string"))
    : [];
}

/**
 * Load secret declarations for an arbitrary set of printer package bindings in
 * one D1 query. Public bindings use their immutable slug; a display name is not
 * an identity and must not be allowed to classify another package's values.
 */
export async function secretVariableNamesByPackageIdForUser(
  env: Env,
  userId: string,
  packageIds: string[],
  db: D1Client = readDb(env),
) {
  const uniqueIds = normalizedPackageIds(packageIds);
  const namesByPackageId = new Map<string, Set<string>>(
    uniqueIds.map((id) => [id, new Set<string>()]),
  );

  for (const packageId of uniqueIds) {
    const builtin = packages.find((candidate) => candidate.id === packageId || candidate.name === packageId);
    if (!builtin) {
      continue;
    }
    const names = namesByPackageId.get(packageId) ?? new Set<string>();
    for (const variable of builtin.variables) {
      if (variable.secret || variable.type === "secret") {
        names.add(variable.name);
      }
    }
    namesByPackageId.set(packageId, names);
  }

  if (uniqueIds.length === 0) {
    return namesByPackageId;
  }

  const rows = await PackageSecretRepository.listBoundDefinitions(db, userId, uniqueIds);

  for (const row of rows) {
    const names = namesByPackageId.get(row.package_id) ?? new Set<string>();
    addSecretDefinitions(names, row.package_json);
    namesByPackageId.set(row.package_id, names);
  }
  return namesByPackageId;
}

export function collectSecretVariableNames(
  packageIds: string[],
  namesByPackageId: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const names = new Set<string>();
  for (const packageId of normalizedPackageIds(packageIds)) {
    for (const name of namesByPackageId.get(packageId) ?? []) {
      names.add(name);
    }
  }
  return names;
}

export async function secretVariableNamesForUserPackages(
  env: Env,
  userId: string,
  packageIds: string[],
  db: D1Client = readDb(env),
) {
  const namesByPackageId = await secretVariableNamesByPackageIdForUser(
    env,
    userId,
    packageIds,
    db,
  );
  return collectSecretVariableNames(packageIds, namesByPackageId);
}
