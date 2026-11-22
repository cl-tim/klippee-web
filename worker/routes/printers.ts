import { and, count, eq, exists, sql } from "drizzle-orm";
import { physicalPrinters as printerTable, privatePackages, publicPackages, syncTokens, diagnosticUploads } from "../schema";
import {
  maxPrinterIdBytes,
  maxPrinterNameBytes,
  maxPrinterVariableValueBytes,
  maxPrinterVariableValuesBytes,
} from "../constants";
import { drizzleDb, writeDb, type DrizzleWriteBatch, type DrizzleWriteQuery } from "../db";
import { json, readJsonBody } from "../http";
import { deleteDefaultPublicPackageCache } from "../packageCatalog";
import {
  collectSecretVariableNames,
  parsePrinterPackageIds,
  scrubPrinterSecretValueStatements,
  secretVariableJsonPaths,
  secretVariableNamesByPackageIdForUser,
  secretVariableNamesForUserPackages,
} from "../packageSecrets";
import {
  isLikelySecretVariableName,
  printerResponse,
  sanitizeVariableValuesForStorage,
} from "../printerShared";
import { PrinterRepository } from "../repositories/PrinterRepository";
import { PrivatePackageRepository, privateBindingSourcesPresent } from "../repositories/PrivatePackageRepository";
import { loadRepositoryFiles } from "../repositoryFiles";
import { maxPrintersPerUser, storageQuotaExceeded } from "../storageLimits";
import type { D1Client, Env } from "../types";
import { isRecord, nowIso, parseStringArray } from "../util";
import { publicFilesForPublish } from "../validation";
import { requireUser } from "./auth";
import {
  removeDiagnosticObjects,
} from "./diagnosticUploads";
import { ensureRepositoryOwner } from "./repositories";

export async function listPrinters(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  // Printer variable values are user-edited state. Read from the primary so a
  // reload immediately after an explicit edit cannot rehydrate an older value
  // from an unconstrained replica.
  const db = writeDb(env);
  const rows = await PrinterRepository.listForUser(db, user.id);

  const packageIdsByPrinter = new Map(rows.map((row) => [
    row.id,
    parsePrinterPackageIds(row.package_ids_json),
  ]));
  const namesByPackageId = await secretVariableNamesByPackageIdForUser(
    env,
    user.id,
    Array.from(packageIdsByPrinter.values()).flat(),
    db,
  );
  const printers = rows.map((row) => printerResponse(
    row,
    collectSecretVariableNames(packageIdsByPrinter.get(row.id) ?? [], namesByPackageId),
  ));

  return json({ printers });
}

export async function getPrinterPublicationCandidate(request: Request, env: Env, printerId: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const row = await PrinterRepository.getPublicationCandidate(writeDb(env), printerId, user.id);
  if (!row) {
    return json({ error: "Printer not found" }, { status: 404 });
  }
  if (
    !row.repository_id
    || row.applied_version_id < 1
    || !row.version_id
    || row.version_number === null
    || !row.files_json
  ) {
    return json({ candidate: null });
  }

  const files = await loadRepositoryFiles(env, row.files_json);
  if (!files) {
    return json({ error: "Stored applied configuration is invalid" }, { status: 422 });
  }

  return json({
    candidate: {
      appliedAt: row.applied_at,
      files: publicFilesForPublish(files),
      repositoryId: row.repository_id,
      versionId: row.version_id,
      versionNumber: row.version_number,
    },
  });
}

type PrinterUpsertInput = {
  createdAt: string;
  definition: Record<string, unknown>;
  description: string;
  existing: { created_at: string; repository_id: string | null } | null;
  hasVariableValues: boolean;
  id: string;
  make: string;
  model: string;
  name: string;
  packageIds: string[];
  privatePackageIds: string[];
  repositoryId: string | null;
  secretVariablePaths: string[];
  source: string;
  variableValuesJson: string;
};

type PrinterUpsertParseResult =
  | { ok: true; value: PrinterUpsertInput }
  | { ok: false; response: Response };

/**
 * Validates the printer upsert body and resolves its DB-dependent inputs (the
 * existing row, the per-user quota, secret variable declarations, and
 * repository ownership). Checks run in the same order as the previous inline
 * handler so error precedence is unchanged.
 */
async function parsePrinterUpsertInput(
  env: Env,
  db: D1Client,
  userId: string,
  printer: unknown,
  timestamp: string,
): Promise<PrinterUpsertParseResult> {
  if (!isRecord(printer)) {
    return { ok: false, response: json({ error: "Printer is required" }, { status: 400 }) };
  }

  let id = crypto.randomUUID();
  if (printer.id !== undefined && printer.id !== null && printer.id !== "") {
    if (
      typeof printer.id !== "string"
      || new TextEncoder().encode(printer.id).byteLength > maxPrinterIdBytes
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(printer.id)
    ) {
      return {
        ok: false,
        response: json({
          error: `Printer ID must start with a letter or number and be at most ${maxPrinterIdBytes} UTF-8 bytes using only ASCII letters, numbers, dots, underscores, or hyphens`,
        }, { status: 400 }),
      };
    }
    id = printer.id;
  }
  const name = typeof printer.name === "string" ? printer.name.trim() : "";
  if (!name) {
    return { ok: false, response: json({ error: "Printer name is required" }, { status: 400 }) };
  }
  if (new TextEncoder().encode(name).byteLength > maxPrinterNameBytes) {
    return {
      ok: false,
      response: json({ error: `Printer name must be at most ${maxPrinterNameBytes} UTF-8 bytes` }, { status: 400 }),
    };
  }

  const existing = await PrinterRepository.getUpsertContext(db, id, userId);
  if (!existing) {
    const usage = await PrinterRepository.countForUser(db, userId);
    if ((usage?.count ?? 0) >= maxPrintersPerUser) {
      return { ok: false, response: storageQuotaExceeded("printers", maxPrintersPerUser) };
    }
  }
  const createdAt = existing?.created_at ?? (typeof printer.createdAt === "string" ? printer.createdAt : timestamp);
  const packageIds = parseStringArray(printer.packageIds) ?? [];
  const definition = isRecord(printer.definition) ? printer.definition : {};
  const hasVariableValues = Object.hasOwn(printer, "variableValues");
  if (hasVariableValues && (!isRecord(printer.variableValues) || Array.isArray(printer.variableValues))) {
    return { ok: false, response: json({ error: "Printer variableValues must be an object" }, { status: 400 }) };
  }
  // Printer metadata saves are intentionally merge-like for variable values.
  // App-state snapshots omit these values, so treating an omitted field as an
  // empty object would erase the dedicated per-printer D1 record on the next
  // name, repository, or workspace update. An explicit {} remains the clear
  // operation.
  const rawVariableValues = hasVariableValues
    ? printer.variableValues as Record<string, unknown>
    : {};
  const privatePackageIds = (await PrivatePackageRepository.listOwnedBindingIds(db, userId, packageIds)).map(row => row.id);
  const secretVariableNames = await secretVariableNamesForUserPackages(env, userId, packageIds, db);
  const variableValues = sanitizeVariableValuesForStorage(rawVariableValues, secretVariableNames);
  const variableValuesJson = JSON.stringify(variableValues);
  if (
    hasVariableValues
    && (
      Object.values(variableValues).some((value) => (
        typeof value === "string"
        && new TextEncoder().encode(value).byteLength > maxPrinterVariableValueBytes
      ))
      || new TextEncoder().encode(variableValuesJson).byteLength > maxPrinterVariableValuesBytes
    )
  ) {
    return {
      ok: false,
      response: json({
        code: "printer_variable_values_too_large",
        error: "Printer variable values exceed the storage limit",
      }, { status: 413 }),
    };
  }
  const secretVariablePaths = secretVariableJsonPaths(secretVariableNames);
  const repositoryId = typeof printer.repositoryId === "string" && printer.repositoryId ? printer.repositoryId : null;
  if (repositoryId) {
    const repository = await ensureRepositoryOwner(db, userId, repositoryId);
    if (!repository) {
      return { ok: false, response: json({ error: "Repository not found" }, { status: 404 }) };
    }
  }

  return {
    ok: true,
    value: {
      createdAt,
      definition,
      description: typeof printer.description === "string" ? printer.description : "",
      existing,
      hasVariableValues,
      id,
      make: typeof printer.make === "string" ? printer.make : "",
      model: typeof printer.model === "string" ? printer.model : "",
      name,
      packageIds,
      privatePackageIds,
      repositoryId,
      secretVariablePaths,
      source: typeof printer.source === "string" ? printer.source : "manual",
      variableValuesJson,
    },
  };
}

/**
 * Statements that sever a printer's previous repository binding when an upsert
 * moves it to a different repository (or unbinds it entirely). Callers batch
 * these with the upsert itself so the rebind stays atomic.
 */
function unbindPrinterRepositoryStatements(
  db: D1Client,
  userId: string,
  printerId: string,
  previousRepositoryId: string | null,
  newRepositoryId: string | null,
  timestamp: string,
  bindingGuard: ReturnType<typeof privateBindingSourcesPresent>,
): DrizzleWriteQuery[] {
  const q = drizzleDb(db);
  return [
    // Retain the owner-approved snapshot while severing its old provenance.
    q.update(publicPackages).set({ repositoryId: null, printerId: null, approvedVersionId: null,
      autoUpdateEnabled: 0, autoUpdateError: null, updatedAt: timestamp,
    }).where(and(eq(publicPackages.userId, userId), eq(publicPackages.printerId, printerId),
      sql`${publicPackages.repositoryId} is ${previousRepositoryId}`, bindingGuard)),
    q.update(printerTable).set({ latestVersionId: 0, appliedVersionId: 0, appliedAt: null })
      .where(and(eq(printerTable.id, printerId), eq(printerTable.userId, userId), bindingGuard)),
    q.update(syncTokens).set({ printerId: null })
      .where(and(eq(syncTokens.printerId, printerId), sql`${syncTokens.repositoryId} is not ${newRepositoryId}`, bindingGuard)),
  ];
}

export async function upsertPrinter(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const bodyResult = await readJsonBody<{ printer?: Record<string, unknown> }>(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const timestamp = nowIso();
  const db = writeDb(env);
  const parsed = await parsePrinterUpsertInput(env, db, user.id, bodyResult.value.printer, timestamp);
  if (!parsed.ok) {
    return parsed.response;
  }
  const {
    createdAt,
    definition,
    description,
    existing,
    hasVariableValues,
    id,
    make,
    model,
    name,
    packageIds,
    privatePackageIds,
    repositoryId,
    secretVariablePaths,
    source,
    variableValuesJson,
  } = parsed.value;

  const q = drizzleDb(db), p = printerTable;
  const owned = q.select({ id: p.id }).from(p).where(and(eq(p.id, id), eq(p.userId, user.id)));
  const total = q.select({ count: count() }).from(p).where(eq(p.userId, user.id));
  const definitionJson = JSON.stringify(definition), packageIdsJson = JSON.stringify(packageIds);
  const bindingGuard = privateBindingSourcesPresent(user.id, privatePackageIds);
  const writes: DrizzleWriteBatch = [q.insert(p).select(sql`select ${id}, ${user.id}, ${name}, ${description},
    ${make}, ${model}, ${source}, ${definitionJson}, ${packageIdsJson}, ${variableValuesJson}, ${repositoryId},
    0, 0, 0, ${createdAt}, ${timestamp}, '{}', NULL, NULL
    where (${exists(owned)} or (${total}) < ${maxPrintersPerUser}) and ${bindingGuard}`).onConflictDoUpdate({ target: p.id, set: {
      name, description, make, model, source, definitionJson, packageIdsJson, repositoryId, updatedAt: timestamp,
      variableValuesJson: hasVariableValues ? variableValuesJson : sql`${p.variableValuesJson}`,
    }, setWhere: eq(p.userId, user.id) })];
  writes.push(...scrubPrinterSecretValueStatements(
    db,
    secretVariablePaths,
    sql`${printerTable.id} = ${id} and ${printerTable.userId} = ${user.id} and ${bindingGuard}`,
  ));
  if (existing && existing.repository_id !== repositoryId) {
    writes.push(...unbindPrinterRepositoryStatements(
      db,
      user.id,
      id,
      existing.repository_id,
      repositoryId,
      timestamp,
      bindingGuard,
    ));
  }
  const results = await q.batch(writes);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const remainingSources = await PrivatePackageRepository.listOwnedBindingIds(db, user.id, privatePackageIds);
    if (remainingSources.length !== privatePackageIds.length) {
      return json({ code: "private_package_bind_conflict", error: "A private package was deleted while saving this printer. Reload its packages before retrying." }, { status: 409 });
    }
    return storageQuotaExceeded("printers", maxPrintersPerUser);
  }
  if (existing && existing.repository_id !== repositoryId) {
    await deleteDefaultPublicPackageCache(env);
  }

  let row = await PrinterRepository.getOwned(db, id, user.id);
  const currentSecretVariableNames = row
    ? await secretVariableNamesForUserPackages(
      env,
      user.id,
      parsePrinterPackageIds(row.package_ids_json),
      db,
    )
    : new Set<string>();
  const currentSecretVariablePaths = secretVariableJsonPaths(currentSecretVariableNames);
  if (row && currentSecretVariablePaths.length > 0) {
    const liveScrubs = scrubPrinterSecretValueStatements(
      db,
      currentSecretVariablePaths,
      sql`${printerTable.id} = ${id} and ${printerTable.userId} = ${user.id}`,
    );
    const [first, ...rest] = liveScrubs;
    if (first) await q.batch([first, ...rest]);
    row = await PrinterRepository.getOwned(db, id, user.id);
  }

  // Re-resolving after the bind closes the reciprocal package-save race: if
  // reclassification committed first this pass scrubs it; if it commits
  // later, the package transaction sees the now-bound printer and scrubs it.
  return json({
    printer: row ? printerResponse(row, currentSecretVariableNames) : null,
  }, { status: existing ? 200 : 201 });
}

/**
 * SQL fragment asserting that no package bound to the printer declares the
 * caller-bound variable name as a secret. The private and public variants
 * differ only in how the package row joins to the printer's binding value
 * (private packages by owner + package id, public packages by slug).
 */
function secretDeclarationAbsentSql(sourceTable: "private" | "public", userId: string, variableName: string) {
  const packageJoin = sourceTable === "private"
    ? sql`join ${privatePackages} package on package.user_id = ${userId} and package.package_id = binding.value`
    : sql`join ${publicPackages} package on package.slug = binding.value`;
  return sql`not exists (
    select 1 from json_each(case when json_valid(${printerTable.packageIdsJson})
      then ${printerTable.packageIdsJson} else '[]' end) binding ${packageJoin}
    join json_each(case when json_valid(package.package_json) and json_type(package.package_json, '$.variables') = 'array'
      then json_extract(package.package_json, '$.variables') else '[]' end) variable
    where json_extract(variable.value, '$.name') = ${variableName}
      and (json_extract(variable.value, '$.secret') = 1 or json_extract(variable.value, '$.type') = 'secret')
  )`;
}

/**
 * The guarded per-name variable write: stores the value only while the row
 * stays within the size budget and no bound package (private or public)
 * declares the name as a secret. The package checks run inside the UPDATE
 * statement, so package secret reclassification and this per-name write are
 * safely ordered whichever request reaches D1 first. A later reclassification
 * scrubs the value in its atomic package batch; an earlier one prevents this
 * write.
 */
function guardedPrinterVariableWriteStatement(db: D1Client, args: {
  printerId: string;
  userId: string;
  value: unknown;
  variableName: string;
  variablePath: string;
}) {
  const encodedValue = JSON.stringify(args.value), p = printerTable;
  const values = sql`json_set(case when json_valid(${p.variableValuesJson}) then ${p.variableValuesJson} else '{}' end,
    ${args.variablePath}, json(${encodedValue}))`;
  return drizzleDb(db).update(p).set({ variableValuesJson: values, updatedAt: nowIso() }).where(and(
    eq(p.id, args.printerId), eq(p.userId, args.userId), sql`length(cast(${values} as blob)) <= ${maxPrinterVariableValuesBytes}`,
    secretDeclarationAbsentSql("private", args.userId, args.variableName), secretDeclarationAbsentSql("public", args.userId, args.variableName),
  ));
}

/**
 * Removes one variable key from the printer's stored values. Secret values
 * stay host-local; removing the same key also cleans up rows created by older
 * clients that predate this boundary.
 */
function removePrinterVariableStatement(
  db: D1Client,
  variablePath: string,
  printerId: string,
  userId: string,
) {
  const p = printerTable;
  return drizzleDb(db).update(p).set({ variableValuesJson: sql`case when json_valid(${p.variableValuesJson})
    then json_remove(${p.variableValuesJson}, ${variablePath}) else '{}' end`, updatedAt: nowIso(),
  }).where(and(eq(p.id, printerId), eq(p.userId, userId)));
}

export async function patchPrinterVariable(
  request: Request,
  env: Env,
  printerId: string,
  variableName: string,
) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }
  if (!/^[a-z][a-z0-9_]*$/.test(variableName)) {
    return json({ error: "Variable name must start with a letter and use lowercase letters, numbers, or underscores" }, { status: 400 });
  }

  const parsedBody = await readJsonBody<{ value?: unknown }>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  if (!isRecord(parsedBody.value) || !Object.hasOwn(parsedBody.value, "value")) {
    return json({ error: "Variable value is required" }, { status: 400 });
  }
  const value = parsedBody.value.value;
  if (
    typeof value !== "string"
    && (typeof value !== "number" || !Number.isFinite(value))
    && typeof value !== "boolean"
    && value !== null
  ) {
    return json({ error: "Variable value must be a string, number, boolean, or null" }, { status: 400 });
  }
  if (
    typeof value === "string"
    && new TextEncoder().encode(value).byteLength > maxPrinterVariableValueBytes
  ) {
    return json({
      code: "printer_variable_value_too_large",
      error: `Printer variable value must be at most ${maxPrinterVariableValueBytes} UTF-8 bytes`,
    }, { status: 413 });
  }

  const db = writeDb(env);
  const variablePath = `$.${variableName}`;
  const initial = await PrinterRepository.getOwned(db, printerId, user.id);
  if (!initial) {
    return json({ error: "Printer not found" }, { status: 404 });
  }
  const initialSecretNames = await secretVariableNamesForUserPackages(
    env,
    user.id,
    parsePrinterPackageIds(initial.package_ids_json),
    db,
  );
  if (!isLikelySecretVariableName(variableName) && !initialSecretNames.has(variableName)) {
    const updated = await guardedPrinterVariableWriteStatement(db, {
      printerId,
      userId: user.id,
      value,
      variableName,
      variablePath,
    }).run();
    if ((updated.meta.changes ?? 0) === 1) {
      const row = await PrinterRepository.getOwned(db, printerId, user.id);
      if (!row) {
        return json({ error: "Printer not found" }, { status: 404 });
      }
      const secretNames = await secretVariableNamesForUserPackages(
        env,
        user.id,
        parsePrinterPackageIds(row.package_ids_json),
        db,
      );
      if (secretNames.has(variableName)) {
        // A concurrent package bind can classify the name after the guarded
        // write starts. Scrub before responding; all reads also apply the same
        // package-aware filter, so the value cannot escape during this race.
        await removePrinterVariableStatement(db, variablePath, printerId, user.id).run();
        const scrubbed = await PrinterRepository.getOwned(db, printerId, user.id);
        return json({
          printer: scrubbed ? printerResponse(scrubbed, secretNames) : null,
          stored: false,
        });
      }
      return json({ printer: printerResponse(row, secretNames), stored: true });
    }
  }

  const existing = await PrinterRepository.getOwned(db, printerId, user.id);
  if (!existing) {
    return json({ error: "Printer not found" }, { status: 404 });
  }

  const existingSecretNames = await secretVariableNamesForUserPackages(
    env,
    user.id,
    parsePrinterPackageIds(existing.package_ids_json),
    db,
  );
  if (!isLikelySecretVariableName(variableName) && !existingSecretNames.has(variableName)) {
    return json({
      code: "printer_variable_values_too_large",
      error: `Printer variable values must total at most ${maxPrinterVariableValuesBytes} UTF-8 bytes`,
    }, { status: 413 });
  }

  await removePrinterVariableStatement(db, variablePath, printerId, user.id).run();
  const scrubbed = await PrinterRepository.getOwned(db, printerId, user.id);
  return json({
    printer: scrubbed ? printerResponse(scrubbed, existingSecretNames) : null,
    stored: false,
  });
}

export async function deletePrinter(request: Request, env: Env, printerId: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const timestamp = nowIso();
  const db = writeDb(env);
  const q = drizzleDb(db);
  // Snapshot upload keys before the printer/token cascades in the same batch.
  const writes = await q.batch([
    q.select({ r2_key: diagnosticUploads.r2Key }).from(diagnosticUploads)
      .where(and(eq(diagnosticUploads.userId, user.id), eq(diagnosticUploads.printerId, printerId))),
    q.update(publicPackages).set({ repositoryId: null, printerId: null, approvedVersionId: null,
      autoUpdateEnabled: 0, autoUpdateError: null, updatedAt: timestamp,
    }).where(and(eq(publicPackages.userId, user.id), eq(publicPackages.printerId, printerId))),
    q.delete(printerTable).where(and(eq(printerTable.id, printerId), eq(printerTable.userId, user.id))),
  ]);
  const diagnosticKeys = writes[0].map(row => row.r2_key).filter(key => typeof key === "string");
  await deleteDefaultPublicPackageCache(env);
  await removeDiagnosticObjects(env, diagnosticKeys);
  return json({ ok: true });
}
