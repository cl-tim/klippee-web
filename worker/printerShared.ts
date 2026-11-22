import { PrinterRepository } from "./repositories/PrinterRepository";
import { writeDb } from "./db";
import {
  parsePrinterPackageIds,
  secretVariableNamesForUserPackages,
} from "./packageSecrets";
import { getSessionUser } from "./routes/auth";
import type { Env, PrinterRow, VariableValues } from "./types";
import { isRecord, parseJsonFallback } from "./util";

export function isLikelySecretVariableName(name: string) {
  return /(?:^|_)(?:api_?key|bearer|pass(?:word|wd)?|secret|token)(?:_|$)/i.test(name);
}

export function printerResponse(row: PrinterRow, secretNames = new Set<string>()) {
  const storedVariableValues = parseJsonFallback(row.variable_values_json, {} as Record<string, unknown>);
  return {
    appliedAt: row.applied_at ?? null,
    appliedVersionId: row.applied_version_id,
    createdAt: row.created_at,
    definition: parseJsonFallback(row.definition_json, {}),
    description: row.description,
    hostInfo: parseJsonFallback(row.host_info_json ?? "{}", {} as Record<string, string>),
    hostInfoUpdatedAt: row.host_info_updated_at ?? null,
    id: row.id,
    latestVersionId: row.latest_version_id,
    make: row.make,
    model: row.model,
    name: row.name,
    packageIds: parsePrinterPackageIds(row.package_ids_json),
    repositoryId: row.repository_id,
    source: row.source,
    updatedAt: row.updated_at,
    // Read-time filtering protects legacy rows written before strict variable
    // storage validation. Package-specific secret names are scrubbed on bind
    // and package save; name-inferred secrets are never returned to browsers.
    variableValues: sanitizeVariableValuesForStorage(storedVariableValues, secretNames),
  };
}

export function sanitizeVariableValuesForStorage(values: unknown, secretNames = new Set<string>()): VariableValues {
  if (!isRecord(values)) {
    return {};
  }
  const entries: Array<[string, string | number | boolean | null]> = [];
  for (const [name, value] of Object.entries(values)) {
    if (
      !secretNames.has(name) &&
      // A workspace-created variable may not belong to a saved package yet,
      // so package metadata cannot be the only secret boundary. Match the
      // editor's fail-closed name inference for direct API clients too.
      !isLikelySecretVariableName(name) &&
      /^[a-z][a-z0-9_]*$/.test(name) &&
      (
        typeof value === "string"
        || (typeof value === "number" && Number.isFinite(value))
        || typeof value === "boolean"
        || value === null
      )
    ) {
      entries.push([name, value]);
    }
  }
  return Object.fromEntries(entries);
}

export async function printerVariableValuesForRequest(request: Request, env: Env, printerId: unknown) {
  if (typeof printerId !== "string" || !printerId.trim()) {
    return {};
  }

  const user = await getSessionUser(request, env);
  if (!user) {
    return {};
  }

  // Rendering immediately after a variable edit must see the same primary
  // state as that edit. It also needs every bound package's secret schema so a
  // legacy value cannot be rendered through a second, non-secret package.
  const db = writeDb(env);
  const printer = await PrinterRepository.getVariableValues(db, printerId, user.id);

  if (!printer) {
    return {};
  }
  const packageIds = parsePrinterPackageIds(printer.package_ids_json);
  const secretNames = await secretVariableNamesForUserPackages(
    env,
    user.id,
    packageIds,
    db,
  );

  return sanitizeVariableValuesForStorage(
    parseJsonFallback(printer.variable_values_json, {} as Record<string, unknown>),
    secretNames,
  );
}
