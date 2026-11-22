import type { ConfigFile, ConfigPackage, PackageVariable, VariableType } from "./types";

export type VariableCandidate = {
  example: string;
  label: string;
  name: string;
  occurrences: number;
  type: VariableType;
};

const includePattern = /^\s*\[include\s+([^\]\s#]+)\s*\]/gim;
const devicePathPattern = /\/dev\/(?:serial\/by-id\/)?[^\s#]+/g;
const ipPattern = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const hostnamePattern = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/gi;
const secretPattern = /\b(password|passwd|token|secret|api[_-]?key|bearer)\b\s*[:=]\s*["']?([^"'\s#]{8,})/gi;
const placeholderPattern = /\$\{KLIPPEE:([a-z][a-z0-9_]*)\}/g;
const sectionPattern = /^\s*\[([^\]]+)\]/;
const optionPattern = /^\s*([a-z][a-z0-9_-]*)\s*[:=]/i;
const importedConfigExtensionPattern = /\.cfg$/i;
const unsafeImportExtensionPattern = /\.(7z|bak|backup|bkp|conf|db|env|gz|ini|json|key|log|mksini|old|orig|pem|rar|secrets|sqlite|swp|tar|tmp|zip)$/i;
const unsafeImportBasenames = new Set([
  "auth.cfg",
  "authorization.cfg",
  "credentials.cfg",
  "credential.cfg",
  "klippee_variables.cfg",
  "mooncord.cfg",
  "moonraker.cfg",
  "moonraker.secrets",
  "mobileraker.cfg",
  "saved_variables.cfg",
  "secret.cfg",
  "secrets.cfg",
  "telegram.cfg",
  "token.cfg",
  "tokens.cfg",
]);

function normalizeIncludePattern(sourcePath: string, includePath: string) {
  const normalizedSource = sourcePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const normalizedInclude = includePath.trim().replace(/\\/g, "/");
  const parts = normalizedInclude.startsWith("/")
    ? []
    : normalizedSource.split("/").slice(0, -1).filter(Boolean);

  for (const part of normalizedInclude.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (!parts.length) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  const normalized = parts.join("/");
  return normalized.endsWith(".cfg") ? normalized : null;
}

function globPattern(pattern: string) {
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        result += ".*";
        index += 1;
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${result}$`);
}

export function workspaceIncludeExists(
  sourcePath: string,
  includePath: string,
  filePaths: ReadonlySet<string>,
) {
  const normalized = normalizeIncludePattern(sourcePath, includePath);
  if (!normalized) {
    return false;
  }
  if (!normalized.includes("*") && !normalized.includes("?")) {
    return filePaths.has(normalized);
  }
  const matcher = globPattern(normalized);
  return Array.from(filePaths).some((path) => matcher.test(path.replace(/\\/g, "/")));
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function readableLabel(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function candidateName(type: VariableType, value: string, index: number) {
  if (type === "device-path") {
    const suffix = value.split(/[/_-]/).filter(Boolean).slice(-3).join("_");
    return slugify(`${suffix || "device"}_path`);
  }

  if (type === "ip-address") {
    return `network_address_${index + 1}`;
  }

  if (type === "hostname") {
    return slugify(`${value.split(".")[0] || `value_${index + 1}`}_hostname`);
  }

  if (type === "secret") {
    return `secret_${index + 1}`;
  }

  return `value_${index + 1}`;
}

function addCandidate(
  candidates: Map<string, VariableCandidate>,
  value: string,
  type: VariableType,
  index: number,
  contextName = "",
) {
  const example = value.trim();
  if (!example || example.includes("${KLIPPEE:")) {
    return;
  }

  const existing = candidates.get(example);
  if (existing) {
    existing.occurrences += 1;
    return;
  }

  const baseName = slugify(contextName) || candidateName(type, example, index);
  const existingNames = new Set(Array.from(candidates.values()).map((candidate) => candidate.name));
  let name = baseName;
  let suffix = 2;
  while (existingNames.has(name)) {
    name = `${baseName}_${suffix}`;
    suffix += 1;
  }
  candidates.set(example, {
    example,
    label: readableLabel(name),
    name,
    occurrences: 1,
    type,
  });
}

export function inferRole(path: string) {
  const name = path.toLowerCase();
  if (name.endsWith("printer.cfg")) {
    return "entrypoint";
  }
  if (name.includes("macro")) {
    return "macro";
  }
  if (name.includes("kamp") || name.includes("mesh") || name.includes("beacon")) {
    return "calibration";
  }
  return "include";
}

export function normalizeImportPath(file: File & { webkitRelativePath?: string }) {
  return file.webkitRelativePath || file.name;
}

export function unsafeWorkspaceImportReason(path: string) {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] ?? "";

  if (!basename) {
    return "empty path";
  }
  if (parts.some((part) => part.startsWith("."))) {
    return "hidden path";
  }
  if (unsafeImportExtensionPattern.test(basename)) {
    return "backup, archive, log, or secret file";
  }
  if (!importedConfigExtensionPattern.test(basename)) {
    return "not a Klipper .cfg file";
  }
  if (unsafeImportBasenames.has(basename) || /(^|[-_.])(auth|credential|secret|token)([-_.]|$)/i.test(basename)) {
    return "sensitive runtime or credential config";
  }

  return null;
}

export function isImportableWorkspaceConfigPath(path: string) {
  return unsafeWorkspaceImportReason(path) === null;
}

export function extractIncludes(files: ConfigFile[]) {
  const filePaths = new Set(files.map((file) => file.path.replace(/\\/g, "/")));
  return Array.from(
    new Set(
      files.flatMap((file) =>
        Array.from(file.content.matchAll(includePattern))
          .map((match) => match[1])
          .filter((path) => !workspaceIncludeExists(file.path, path, filePaths)),
      ),
    ),
  ).sort();
}

export function extractVariableCandidates(files: ConfigFile[]) {
  const candidates = new Map<string, VariableCandidate>();
  let index = 0;

  for (const file of files) {
    let section = "";
    for (const line of file.content.split(/\r?\n/)) {
      const sectionMatch = line.match(sectionPattern);
      if (sectionMatch) {
        section = slugify(sectionMatch[1]);
      }
      const option = slugify(line.match(optionPattern)?.[1] ?? "");
      const contextName = [section, option].filter(Boolean).join("_");

      for (const match of line.matchAll(devicePathPattern)) {
        addCandidate(candidates, match[0], "device-path", index++, contextName);
      }
      for (const match of line.matchAll(ipPattern)) {
        addCandidate(candidates, match[0], "ip-address", index++, contextName);
      }
      for (const match of line.matchAll(hostnamePattern)) {
        if (!match[0].startsWith("KLIPPEE") && !/^\d+(?:\.\d+){3}$/.test(match[0])) {
          addCandidate(candidates, match[0], "hostname", index++, contextName);
        }
      }
      for (const match of line.matchAll(secretPattern)) {
        addCandidate(candidates, match[2], "secret", index++, [section, slugify(match[1])].filter(Boolean).join("_"));
      }
    }
  }

  return Array.from(candidates.values()).sort((a, b) => b.occurrences - a.occurrences);
}

export function applyVariableCandidate(files: ConfigFile[], candidate: VariableCandidate) {
  const escaped = candidate.example.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replacement = `\${KLIPPEE:${candidate.name}}`;
  return files.map((file) => ({
    ...file,
    content: file.content.replace(new RegExp(escaped, "g"), replacement),
  }));
}

export function variablesFromFiles(files: ConfigFile[], candidates: VariableCandidate[]) {
  const candidateByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  const names = new Set<string>();
  for (const file of files) {
    for (const match of file.content.matchAll(placeholderPattern)) {
      names.add(match[1]);
    }
  }

  return Array.from(names)
    .sort()
    .map<PackageVariable>((name) => {
      const candidate = candidateByName.get(name);
      const inferredType: VariableType = name.startsWith("secret_") || /_(?:password|passwd|token|secret|api_key|bearer)$/.test(name)
        ? "secret"
        : name.endsWith("_path") || name.endsWith("_serial")
        ? "device-path"
        : name.endsWith("_hostname")
        ? "hostname"
        : name.includes("network_address") || name.endsWith("_address") || name.endsWith("_ip")
        ? "ip-address"
        : name.endsWith("_host")
        ? "hostname"
        : "string";
      const type = candidate?.type ?? inferredType;
      return {
        description: candidate ? `Printer-specific value detected from ${candidate.example}.` : `Value for ${name}.`,
        example: candidate?.example,
        label: candidate?.label ?? readableLabel(name),
        name,
        required: true,
        secret: type === "secret",
        type,
      };
    });
}

export function buildPrivatePackage({
  description,
  files,
  hardware,
  id,
  printer,
  tags,
  title,
  variables,
}: {
  description: string;
  files: ConfigFile[];
  hardware: string[];
  id: string;
  printer: string;
  tags: string[];
  title: string;
  variables: PackageVariable[];
}): ConfigPackage {
  const version = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
  const name = slugify(title).replace(/_/g, "-") || id;

  return {
    description: description.trim() || `Reusable package for ${printer || title}.`,
    files: files.map((file) => ({ ...file, public: false, role: file.role || inferRole(file.path) })),
    hardware,
    id,
    name,
    printer: printer.trim() || "Custom printer",
    tags: Array.from(new Set(["private", ...tags])).filter(Boolean),
    title: title.trim() || "Private printer package",
    variables,
    version,
    warnings: [
      "Review generated variables before installing on a printer.",
      "Create a printer-side backup before applying rendered files.",
    ],
  };
}
