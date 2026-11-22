import type { ConfigFile, ConfigPackage, PackageVariable } from "./types";
import { zipSync } from "fflate";
import { maxRenderedPackageBytes } from "./app/constants";
import {
  TemplateRenderLimitError,
  renderTemplateContent,
  renderTemplateFiles,
  unresolvedTemplateVariables,
} from "./templateRendering";

export type VariableValues = Record<string, string>;
export { TemplateRenderLimitError as PackageRenderLimitError };

export function renderContent(content: string | null | undefined, values: VariableValues) {
  return renderTemplateContent(content ?? "", values);
}

export function renderFiles(
  files: ConfigFile[],
  values: VariableValues,
  limitBytes = maxRenderedPackageBytes,
) {
  return renderTemplateFiles(files, values, limitBytes);
}

export function unresolvedVariables(content: string) {
  return unresolvedTemplateVariables(content);
}

export function validateVariable(variable: PackageVariable, value: string) {
  if (variable.required && !value.trim()) {
    return "Required";
  }

  if (!value.trim()) {
    return "";
  }

  if (variable.type === "device-path" && !value.startsWith("/dev/")) {
    return "Expected a Linux device path starting with /dev/";
  }

  if (variable.type === "number" && Number.isNaN(Number(value))) {
    return "Expected a number";
  }

  if (variable.type === "url") {
    try {
      new URL(value);
    } catch {
      return "Expected a valid URL";
    }
  }

  return "";
}

export function validateVariables(pkg: ConfigPackage, values: VariableValues) {
  return Object.fromEntries(
    pkg.variables
      .map((variable) => [
        variable.name,
        validateVariable(
          variable,
          Object.prototype.hasOwnProperty.call(values, variable.name) ? values[variable.name] : "",
        ),
      ])
      .filter(([, message]) => message),
  ) as Record<string, string>;
}

export function declaredPackageVariableValues(pkg: ConfigPackage, values: VariableValues) {
  const declaredNames = new Set(pkg.variables.map((variable) => variable.name));
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => declaredNames.has(name)),
  ) as VariableValues;
}

function toArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function createPackageZip(pkg: ConfigPackage, values: VariableValues) {
  const encoder = new TextEncoder();
  const declaredValues = declaredPackageVariableValues(pkg, values);
  const renderedFiles = renderFiles(pkg.files, declaredValues);
  const summary = {
    package: pkg.name,
    version: pkg.version,
    renderedAt: new Date().toISOString(),
    variables: pkg.variables.map((variable) => ({
      name: variable.name,
      supplied: Boolean(
        Object.prototype.hasOwnProperty.call(declaredValues, variable.name) && declaredValues[variable.name],
      ),
      secret: variable.secret || variable.type === "secret",
    })),
    warnings: pkg.warnings,
    files: renderedFiles.map((file) => ({
      path: file.path,
      role: file.role,
      rendered: file.content !== pkg.files.find((source) => source.path === file.path)?.content,
    })),
  };

  const zipFiles: Record<string, Uint8Array> = {
    "klippee-render-summary.json": encoder.encode(JSON.stringify(summary, null, 2)),
  };

  for (const file of renderedFiles) {
    zipFiles[file.path] = encoder.encode(file.content);
  }

  return new Blob([toArrayBuffer(zipSync(zipFiles))], { type: "application/zip" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function changedPaths(before: ConfigFile[], after: ConfigFile[]) {
  return after
    .filter((file) => before.find((candidate) => candidate.path === file.path)?.content !== file.content)
    .map((file) => file.path);
}
