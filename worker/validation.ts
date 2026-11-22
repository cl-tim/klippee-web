import { scanConfigFiles } from "../src/safety";
import type { ConfigPackage, PackageVariable } from "../src/types";
import {
  maxConfigFileBytes,
  maxConfigPathLength,
  maxConfigRoleBytes,
  maxFilesPerPayload,
  maxRepositoryVersionMessageBytes,
  maxRepositoryVersionSourceBytes,
} from "./constants";
import type { RepositoryFilesManifest, StoredConfigFile, VariableValues } from "./types";
import { isRecord, parseStringArray } from "./util";

export function normalizeConfigPath(value: string) {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized
    || new TextEncoder().encode(normalized).byteLength > maxConfigPathLength
    || /^[a-z]:/i.test(normalized)
  ) {
    return null;
  }

  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return null;
  }

  return normalized;
}

export function configPathCollisionKey(path: string) {
  return path.normalize("NFC").toLowerCase();
}

export function normalizeConfigRole(value: unknown) {
  if (value === undefined) {
    return "include";
  }
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > maxConfigRoleBytes) {
    return null;
  }
  return normalized;
}

function parseOptionalBoundedMetadata(value: unknown, label: string, maxBytes: number) {
  if (value === undefined || value === null) {
    return { ok: true as const, value: null };
  }
  if (typeof value !== "string") {
    return { error: `${label} must be a string`, ok: false as const };
  }

  const normalized = value.trim();
  if (!normalized) {
    return { ok: true as const, value: null };
  }
  if (new TextEncoder().encode(normalized).byteLength > maxBytes) {
    return { error: `${label} must be at most ${maxBytes} UTF-8 bytes`, ok: false as const };
  }
  return { ok: true as const, value: normalized };
}

export function parseRepositoryVersionMessage(value: unknown) {
  return parseOptionalBoundedMetadata(value, "Version message", maxRepositoryVersionMessageBytes);
}

export function parseRepositoryVersionSource(value: unknown) {
  return parseOptionalBoundedMetadata(value, "Version source", maxRepositoryVersionSourceBytes);
}

export function parseFiles(value: unknown): StoredConfigFile[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  if (value.length > maxFilesPerPayload) {
    return null;
  }

  const files = value.map((file) => {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof (file as { path?: unknown }).path !== "string" ||
      typeof (file as { content?: unknown }).content !== "string"
    ) {
      return null;
    }

    const path = normalizeConfigPath((file as { path: string }).path);
    const role = normalizeConfigRole((file as { role?: unknown }).role);
    const content = (file as { content: string }).content;
    if (!path || !role || new TextEncoder().encode(content).length > maxConfigFileBytes) {
      return null;
    }

    return {
      content,
      path,
      public: typeof (file as { public?: unknown }).public === "boolean" ? (file as { public: boolean }).public : false,
      role,
    };
  });

  if (!files.every(Boolean)) {
    return null;
  }
  const validFiles = files as StoredConfigFile[];
  if (new Set(validFiles.map((file) => configPathCollisionKey(file.path))).size !== validFiles.length) {
    return null;
  }
  return validFiles;
}

export function describeInvalidFiles(value: unknown) {
  if (!Array.isArray(value)) {
    return "Files must include path and content";
  }

  if (value.length > maxFilesPerPayload) {
    return `Too many files: ${value.length} exceeds the ${maxFilesPerPayload}-file limit; remove old backups or unused configs and retry`;
  }

  const paths = new Set<string>();
  const collisionPaths = new Map<string, string>();
  for (const file of value) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof (file as { path?: unknown }).path !== "string" ||
      typeof (file as { content?: unknown }).content !== "string"
    ) {
      return "Files must include path and content";
    }

    const rawPath = (file as { path: string }).path;
    const normalizedPath = normalizeConfigPath(rawPath);
    if (!normalizedPath) {
      return `Invalid file path: ${rawPath || "(empty)"}`;
    }
    if (paths.has(normalizedPath)) {
      return `Duplicate file path: ${normalizedPath}`;
    }
    paths.add(normalizedPath);
    const collisionKey = configPathCollisionKey(normalizedPath);
    const collidingPath = collisionPaths.get(collisionKey);
    if (collidingPath) {
      return `Conflicting file paths: ${collidingPath} and ${normalizedPath}`;
    }
    collisionPaths.set(collisionKey, normalizedPath);

    if (!normalizeConfigRole((file as { role?: unknown }).role)) {
      return `Invalid file role: roles must be non-empty strings of at most ${maxConfigRoleBytes} UTF-8 bytes`;
    }

    const byteLength = new TextEncoder().encode((file as { content: string }).content).length;
    if (byteLength > maxConfigFileBytes) {
      return `File too large: ${rawPath} is ${byteLength} bytes; the per-file limit is ${maxConfigFileBytes} bytes`;
    }
  }

  return "Files must include path and content";
}

const hostInfoFields = [
  "arch",
  "cliVersion",
  "hostname",
  "kernel",
  "klipperVersion",
  "klippyState",
  "moonrakerVersion",
  "os",
] as const;
const maxHostInfoFieldLength = 120;

export function parseHostInfo(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const info: Record<string, string> = {};
  for (const field of hostInfoFields) {
    const raw = value[field];
    if (typeof raw !== "string") {
      continue;
    }
    // eslint-disable-next-line no-control-regex
    const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxHostInfoFieldLength);
    if (cleaned) {
      info[field] = cleaned;
    }
  }

  return info;
}

export function isRepositoryFilesManifest(value: unknown): value is RepositoryFilesManifest {
  return (
    isRecord(value) &&
    value.storage === "r2" &&
    value.version === 1 &&
    typeof value.key === "string" &&
    typeof value.sha256 === "string" &&
    typeof value.byteLength === "number" &&
    typeof value.fileCount === "number"
  );
}

export function parsePackageVariables(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  const variables = value.filter((variable): variable is PackageVariable => {
    return (
      isRecord(variable) &&
      typeof variable.name === "string" &&
      typeof variable.label === "string" &&
      typeof variable.description === "string" &&
      typeof variable.type === "string" &&
      typeof variable.required === "boolean" &&
      typeof variable.secret === "boolean" &&
      (variable.example === undefined || typeof variable.example === "string")
    );
  });

  if (variables.length !== value.length) {
    return null;
  }

  // `secret` is the policy bit consumed by older render and download paths.
  // Normalize the explicit secret type at the trust boundary so an
  // inconsistent payload cannot opt a secret value back into persistence,
  // query strings, previews, or generated summaries.
  return variables.map((variable) => (
    variable.type === "secret" && !variable.secret
      ? { ...variable, secret: true }
      : variable
  ));
}

export function parseConfigPackage(value: unknown): ConfigPackage | null {
  if (!isRecord(value)) {
    return null;
  }

  const files = parseFiles(value.files);
  const hardware = parseStringArray(value.hardware);
  const tags = parseStringArray(value.tags);
  const variables = parsePackageVariables(value.variables);
  const warnings = parseStringArray(value.warnings);
  const companionAssetIds = value.companionAssetIds === undefined ? [] : parseStringArray(value.companionAssetIds);
  if (!files || !hardware || !tags || !variables || !warnings || !companionAssetIds) {
    return null;
  }

  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.title !== "string" ||
    typeof value.version !== "string" ||
    typeof value.printer !== "string" ||
    typeof value.description !== "string"
  ) {
    return null;
  }

  return {
    description: value.description,
    files: files.map((file) => ({
      content: file.content,
      path: file.path,
      public: typeof file.public === "boolean" ? file.public : false,
      role: typeof file.role === "string" ? file.role : "include",
    })),
    hardware,
    id: value.id,
    name: value.name,
    printer: value.printer,
    tags,
    title: value.title,
    variables,
    version: value.version,
    warnings,
    companionAssetIds,
  };
}

export function packageIdFromPublishBody(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.packageId === "string" && value.packageId.trim()) {
    return value.packageId.trim();
  }

  const packageValue = value.package;
  if (isRecord(packageValue) && typeof packageValue.id === "string" && packageValue.id.trim()) {
    return packageValue.id.trim();
  }

  return null;
}

export function isPrivateOnlyPublishPath(path: string) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  return (
    normalized.startsWith(".klippee/") ||
    normalized.includes("/.klippee/") ||
    basename === "klippee_variables.cfg" ||
    basename === "saved_variables.cfg" ||
    basename === "moonraker.secrets" ||
    /\.(bak|bkp|log|zip|tar|gz|7z|rar)$/i.test(normalized)
  );
}

export function sanitizePublicPackageVariables(variables: PackageVariable[]) {
  return variables.map((variable) => {
    const secret = variable.secret || variable.type === "secret";
    if (!secret) {
      return variable;
    }

    return {
      ...variable,
      description: "Secret value. Provide it privately when rendering or installing this package.",
      example: undefined,
      secret: true,
    };
  });
}

export function publicFilesForPublish(files: StoredConfigFile[]): StoredConfigFile[] {
  return files
    .filter((file) => !isPrivateOnlyPublishPath(file.path))
    .map((file) => ({ ...file, public: true }));
}

export function publicPackageForPublish(pkg: ConfigPackage): ConfigPackage {
  return {
    ...pkg,
    files: publicFilesForPublish(pkg.files),
    tags: Array.from(new Set(["public", ...pkg.tags.filter((tag) => tag !== "private")])),
    warnings: Array.from(new Set([
      ...pkg.warnings,
      "Published packages are visible to anyone with the package URL.",
    ])),
    variables: sanitizePublicPackageVariables(pkg.variables),
  };
}

export function hasWarningSafetyFindings(findings: ReturnType<typeof scanConfigFiles>) {
  return findings.some((finding) => finding.severity === "warn");
}

export function validatePackageVariables(pkg: ConfigPackage, values: VariableValues) {
  const errors: Record<string, string> = {};

  for (const variable of pkg.variables) {
    const rawValue = Object.prototype.hasOwnProperty.call(values, variable.name)
      ? values[variable.name]
      : undefined;
    const value = rawValue === null || rawValue === undefined ? "" : String(rawValue);

    if (variable.required && !value.trim()) {
      errors[variable.name] = "Required";
      continue;
    }

    if (!value.trim()) {
      continue;
    }

    if (variable.type === "device-path" && !value.startsWith("/dev/")) {
      errors[variable.name] = "Expected a Linux device path starting with /dev/";
    }

    if (variable.type === "number" && Number.isNaN(Number(value))) {
      errors[variable.name] = "Expected a number";
    }

    if (variable.type === "url") {
      try {
        new URL(value);
      } catch {
        errors[variable.name] = "Expected a valid URL";
      }
    }
  }

  return errors;
}
