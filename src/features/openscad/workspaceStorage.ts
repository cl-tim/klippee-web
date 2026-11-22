import type { OpenScadParameterValue, OpenScadSourceFile } from "./types";
import type { AccountStorage } from "../../storage";

export const openScadWorkspaceStorageName = "openScadWorkspace";
const maxStoredSourceBytes = 4 * 1024 * 1024;
const maxStoredFiles = 32;

export type OpenScadWorkspaceSnapshot = {
  files: OpenScadSourceFile[];
  mainFile: string;
  parameterValues: Record<string, OpenScadParameterValue>;
};

type StoredOpenScadWorkspace = OpenScadWorkspaceSnapshot & {
  version: 1;
};

function isSafeScadName(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 240 || !value.toLowerCase().endsWith(".scad")) {
    return false;
  }
  const parts = value.replace(/\\/g, "/").split("/");
  return parts.every((part) =>
    Boolean(part)
    && part !== "."
    && part !== ".."
    && !/[<>:"|?*]/.test(part)
    && !Array.from(part).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }),
  );
}

function isParameterValue(value: unknown): value is OpenScadParameterValue {
  return typeof value === "string"
    ? value.length <= 2_000
    : typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function parseStoredWorkspace(value: unknown): OpenScadWorkspaceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StoredOpenScadWorkspace>;
  if (
    candidate.version !== 1
    || !Array.isArray(candidate.files)
    || candidate.files.length < 1
    || candidate.files.length > maxStoredFiles
    || !isSafeScadName(candidate.mainFile)
    || !candidate.parameterValues
    || typeof candidate.parameterValues !== "object"
  ) {
    return null;
  }

  let sourceBytes = 0;
  const files: OpenScadSourceFile[] = [];
  for (const file of candidate.files) {
    if (
      !file
      || typeof file !== "object"
      || !("name" in file)
      || !isSafeScadName(file.name)
      || !("source" in file)
      || typeof file.source !== "string"
      || ("engine" in file && file.engine !== undefined && file.engine !== "openscad")
    ) {
      return null;
    }
    sourceBytes += new TextEncoder().encode(file.source).byteLength;
    if (sourceBytes > maxStoredSourceBytes) return null;
    files.push({ engine: "openscad", name: file.name, source: file.source });
  }
  if (!files.some((file) => file.name === candidate.mainFile)) return null;

  const parameterValues = Object.fromEntries(
    Object.entries(candidate.parameterValues).filter(([key, parameterValue]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && isParameterValue(parameterValue),
    ),
  );
  return { files, mainFile: candidate.mainFile, parameterValues };
}

export function loadOpenScadWorkspace(storage: AccountStorage): OpenScadWorkspaceSnapshot | null {
  return parseStoredWorkspace(storage.loadStored<unknown>(openScadWorkspaceStorageName, null));
}

export function saveOpenScadWorkspace(storage: AccountStorage, snapshot: OpenScadWorkspaceSnapshot) {
  const scadFiles = snapshot.files
    .filter((file) => (file.engine ?? "openscad") === "openscad")
    .map((file) => ({ engine: "openscad" as const, name: file.name, source: file.source }));
  if (
    scadFiles.length > maxStoredFiles
    || scadFiles.some((file) => !isSafeScadName(file.name))
    || scadFiles.reduce((total, file) => total + new TextEncoder().encode(file.source).byteLength, 0) > maxStoredSourceBytes
  ) {
    throw new Error("The OpenSCAD workspace exceeds browser storage limits.");
  }
  const mainFile = scadFiles.some((file) => file.name === snapshot.mainFile)
    ? snapshot.mainFile
    : scadFiles[0]?.name;
  if (!mainFile) return;

  const value: StoredOpenScadWorkspace = {
    files: scadFiles,
    mainFile,
    parameterValues: snapshot.parameterValues,
    version: 1,
  };
  storage.saveStored(openScadWorkspaceStorageName, value);
}
