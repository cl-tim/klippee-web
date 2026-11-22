import { initialHistory } from "../data";
import type { VariableValues } from "../rendering";
import type { AccountStorage } from "../storage";
import type { CompanionAsset, ConfigFile, ConfigPackage, HistoryVersion } from "../types";
import type { PrinterRecord } from "./types";

export function loadInitialHistory(loadStored: AccountStorage["loadStored"]) {
  return loadStored("history", initialHistory);
}

export function loadInitialPrivatePackages(loadStored: AccountStorage["loadStored"]) {
  return loadStored("privatePackages", [] as ConfigPackage[]);
}

export function loadInitialCompanionAssets(loadStored: AccountStorage["loadStored"]) {
  return loadStored("companionAssets", [] as CompanionAsset[]);
}

export function loadInitialWorkspaceContent(
  history: HistoryVersion[],
  loadStored: AccountStorage["loadStored"],
) {
  if (history.length === 0) {
    return "";
  }

  return loadStored(
    "workspaceContent",
    history[history.length - 1]?.files.find((file) => file.path === "printer.cfg")?.content ?? "",
  );
}

export function createPrinterRecord({
  description,
  definition,
  make,
  model,
  name,
  source,
}: {
  description?: string;
  definition?: Record<string, unknown>;
  make: string;
  model: string;
  name: string;
  source: PrinterRecord["source"];
}): PrinterRecord {
  const timestamp = new Date().toISOString();
  const fallbackName = [make, model].filter(Boolean).join(" ") || "Untitled printer";
  return {
    appliedVersionId: 0,
    createdAt: timestamp,
    definition,
    description: description?.trim() ?? "",
    id: `printer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    latestVersionId: 0,
    history: [],
    make,
    model,
    name: name.trim() || fallbackName,
    packageIds: [],
    companionAssetIds: [],
    repositoryId: null,
    source,
    updatedAt: timestamp,
    variableValues: {},
    workspaceFilePath: "printer.cfg",
  };
}

export function snapshotPrinterWorkspace(
  record: PrinterRecord,
  workspace: {
    history: HistoryVersion[];
    workspaceDraftFiles: ConfigFile[] | null;
    workspaceDrafts: Record<string, string>;
    workspaceFilePath: string;
  },
): PrinterRecord {
  return {
    ...record,
    history: workspace.history,
    workspaceDraftFiles: workspace.workspaceDraftFiles,
    workspaceDrafts: workspace.workspaceDrafts,
    workspaceFilePath: workspace.workspaceFilePath,
  };
}

export function reconcileCloudPrinters(
  localPrinters: PrinterRecord[],
  cloudPrinters: PrinterRecord[],
  localVariableValuesByPrinter: ReadonlyMap<string, VariableValues> = new Map(),
) {
  const localById = new Map(localPrinters.map((record) => [record.id, record]));

  return cloudPrinters
    .map((cloudRecord) => {
      const localRecord = localById.get(cloudRecord.id);
      const localVariableValues = {
        ...(localRecord?.variableValues ?? {}),
        ...(localVariableValuesByPrinter.get(cloudRecord.id) ?? {}),
      };
      const variableValues = {
        ...localVariableValues,
        ...(cloudRecord.variableValues ?? {}),
      };
      if (!localRecord) {
        return Object.keys(localVariableValues).length > 0
          ? { ...cloudRecord, variableValues }
          : cloudRecord;
      }
      const sameRepository = localRecord.repositoryId === cloudRecord.repositoryId;

      return {
        ...cloudRecord,
        companionAssetIds: localRecord.companionAssetIds,
        history: localRecord.history,
        variableValues,
        workspaceBaseRevision: sameRepository ? localRecord.workspaceBaseRevision : undefined,
        workspaceBaseFiles: sameRepository ? localRecord.workspaceBaseFiles : undefined,
        workspaceDraftFiles: sameRepository ? localRecord.workspaceDraftFiles : undefined,
        workspaceDrafts: sameRepository ? localRecord.workspaceDrafts : undefined,
        workspaceFilePath: sameRepository ? localRecord.workspaceFilePath : undefined,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function packageZipUrl(pkg: ConfigPackage | null, values: VariableValues) {
  if (!pkg) {
    return "";
  }

  const url = new URL(`/api/packages/${pkg.id}/download.zip`, window.location.origin);
  for (const variable of pkg.variables) {
    if (variable.secret || variable.type === "secret") {
      continue;
    }
    const value = Object.prototype.hasOwnProperty.call(values, variable.name)
      ? values[variable.name]
      : undefined;
    if (value !== null && value !== undefined && String(value).trim()) {
      url.searchParams.set(variable.name, String(value));
    }
  }
  return url.toString();
}

export function shellCommandQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function powershellQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sortConfigFiles(files: ConfigFile[]) {
  return [...files].sort((a, b) => {
    if (a.path.endsWith("printer.cfg")) {
      return -1;
    }
    if (b.path.endsWith("printer.cfg")) {
      return 1;
    }
    return a.path.localeCompare(b.path);
  });
}

export function normalizeWorkspacePath(value: string) {
  // Strip leading "./" and "/" so paths like "./KAMP/Smart_Park.cfg" from
  // [include ./...] directives normalize the same as bare "KAMP/Smart_Park.cfg".
  const normalized = value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || !normalized.endsWith(".cfg") || parts.some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return normalized;
}
