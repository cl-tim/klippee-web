import { json, readJsonBody } from "../http";
import { enforceRateLimit } from "../rateLimit";
import type { Env } from "../types";

const maxImportFiles = 64;
const maxImportFileBytes = 1024 * 1024;
const maxImportTotalBytes = 8 * 1024 * 1024;
const maxGitHubMetadataBytes = 1024 * 1024;
const maxRedirects = 3;

type ImportedScadFile = {
  name: string;
  source: string;
};

type GitHubTreeEntry = {
  path: string;
  size?: number;
  type: string;
};

type ImportTarget =
  | { kind: "direct"; name: string; url: URL }
  | { kind: "github-tree"; owner: string; path: string; ref?: string; repository: string };

class ScadImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

// Hostname allow rules for outbound imports. Note on DNS rebinding: these checks
// validate the hostname *string*, but Workers `fetch` resolves DNS itself and does
// not expose or let us pin the resolved address, so a public hostname that resolves
// to a private/link-local IP cannot be fully blocked at this layer. On the Workers
// edge the practical impact is limited (it does not route to RFC1918/metadata
// addresses the way a self-hosted origin would), imports are rate-limited, and every
// redirect hop is re-validated. Rejecting IP-literal and numeric hosts below removes
// direct-to-address targeting; the residual rebinding risk is accepted and tracked.
function safeRemoteUrl(value: string | URL) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ScadImportError("Enter a valid public HTTPS URL.");
  }
  // Strip IPv6 brackets and any trailing FQDN-root dot so "127.0.0.1." (5 split
  // parts) cannot dodge the IPv4 check and resolve to loopback anyway.
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  // A registrable public domain always ends in an alphabetic label (com, dev,
  // xn--…). Requiring one rejects bare IPv4 literals ("8.8.8.8"), numeric hosts,
  // and the trailing-dot loopback form that the private-range checks would miss.
  const lastLabel = hostname.split(".").pop() ?? "";
  const isIpLiteralOrNumericHost = !/[a-z]/.test(lastLabel);
  const isPrivateIpv6 = hostname === "::"
    || hostname === "::1"
    || hostname.startsWith("::ffff:")
    || hostname.startsWith("fc")
    || hostname.startsWith("fd")
    || hostname.startsWith("fe8")
    || hostname.startsWith("fe9")
    || hostname.startsWith("fea")
    || hostname.startsWith("feb")
    || hostname.startsWith("fec")
    || hostname.startsWith("fed")
    || hostname.startsWith("fee")
    || hostname.startsWith("fef");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || !hostname.includes(".")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || isIpLiteralOrNumericHost
    || isPrivateIpv4(hostname)
    || isPrivateIpv6
  ) {
    throw new ScadImportError("Only public HTTPS URLs are supported.");
  }
  url.hash = "";
  return url;
}

function decodedPathParts(url: URL) {
  try {
    return url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new ScadImportError("The URL contains an invalid path.");
  }
}

function safeScadPath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    !normalized
    || normalized.length > 240
    || !normalized.toLowerCase().endsWith(".scad")
    || parts.some((part) =>
      !part
      || part === "."
      || part === ".."
      || /[<>:"|?*]/.test(part)
      || Array.from(part).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      }),
    )
  ) {
    throw new ScadImportError("Remote OpenSCAD files must use safe relative .scad paths.");
  }
  return normalized;
}

export function parseScadImportTarget(value: string): ImportTarget {
  const url = safeRemoteUrl(value.trim());
  const parts = decodedPathParts(url);

  if (url.hostname.toLowerCase() === "github.com") {
    if (parts.length < 2) {
      throw new ScadImportError("Use a GitHub repository, folder, or .scad file URL.");
    }
    const [owner, repositoryWithSuffix, view, ref, ...pathParts] = parts;
    const repository = repositoryWithSuffix.replace(/\.git$/i, "");
    if (!owner || !repository) {
      throw new ScadImportError("Use a valid public GitHub repository URL.");
    }
    if (view === "blob" && ref && pathParts.length) {
      const path = safeScadPath(pathParts.join("/"));
      return {
        kind: "direct",
        name: path.split("/").at(-1) ?? path,
        url: safeRemoteUrl(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(ref)}/${pathParts.map(encodeURIComponent).join("/")}`),
      };
    }
    if (view === "tree" && ref) {
      return {
        kind: "github-tree",
        owner,
        path: pathParts.join("/").replace(/^\/+|\/+$/g, ""),
        ref,
        repository,
      };
    }
    if (!view) {
      return { kind: "github-tree", owner, path: "", repository };
    }
    throw new ScadImportError("Use a GitHub repository, folder, or .scad file URL.");
  }

  if (!url.pathname.toLowerCase().endsWith(".scad")) {
    throw new ScadImportError("Use a direct .scad URL or a public GitHub repository or folder URL.");
  }
  const name = safeScadPath(decodedPathParts(url).at(-1) ?? "");
  return { kind: "direct", name, url };
}

async function readBoundedText(response: Response, maxBytes: number, oversizedMessage: string) {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ScadImportError(oversizedMessage, 413);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytesRead += result.value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new ScadImportError(oversizedMessage, 413);
    }
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchRemoteText(value: string | URL, maxBytes: number, accept: string, oversizedMessage: string) {
  let url = safeRemoteUrl(value);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(url, {
      headers: {
        accept,
        "user-agent": "Klippee-SCAD-Importer/1.0",
      },
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === maxRedirects) {
        throw new ScadImportError("The remote URL redirected too many times.", 502);
      }
      url = safeRemoteUrl(new URL(location, url));
      continue;
    }
    if (!response.ok) {
      throw new ScadImportError(`The remote server returned HTTP ${response.status}.`, 502);
    }
    return readBoundedText(response, maxBytes, oversizedMessage);
  }
  throw new ScadImportError("The remote URL could not be loaded.", 502);
}

async function fetchGitHubJson(value: string | URL) {
  const text = await fetchRemoteText(
    value,
    maxGitHubMetadataBytes,
    "application/vnd.github+json",
    "The GitHub repository listing is too large.",
  );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ScadImportError("GitHub returned an invalid repository listing.", 502);
  }
}

function githubApiUrl(path: string) {
  return safeRemoteUrl(`https://api.github.com${path}`);
}

async function resolveGitHubRef(target: Extract<ImportTarget, { kind: "github-tree" }>) {
  if (target.ref) return target.ref;
  const metadata = await fetchGitHubJson(
    githubApiUrl(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`),
  );
  if (
    !metadata
    || typeof metadata !== "object"
    || !("default_branch" in metadata)
    || typeof metadata.default_branch !== "string"
  ) {
    throw new ScadImportError("GitHub did not return the repository's default branch.", 502);
  }
  return metadata.default_branch;
}

function parseGitHubTree(value: unknown) {
  if (!value || typeof value !== "object" || !("tree" in value) || !Array.isArray(value.tree)) {
    throw new ScadImportError("GitHub did not return a repository file listing.", 502);
  }
  if ("truncated" in value && value.truncated === true) {
    throw new ScadImportError("This GitHub repository is too large. Use a URL to a smaller folder.", 413);
  }
  return value.tree.filter((entry): entry is GitHubTreeEntry =>
    Boolean(
      entry
      && typeof entry === "object"
      && "path" in entry
      && typeof entry.path === "string"
      && "type" in entry
      && typeof entry.type === "string",
    ));
}

async function fetchScadFile(name: string, url: URL) {
  const source = (await fetchRemoteText(
    url,
    maxImportFileBytes,
    "text/plain, application/octet-stream;q=0.9",
    `${name} is larger than 1 MB.`,
  )).replace(/^\uFEFF/, "");
  if (!source.trim() || source.includes("\u0000")) {
    throw new ScadImportError(`${name} is empty or is not a text OpenSCAD file.`);
  }
  return { name, source } satisfies ImportedScadFile;
}

async function importGitHubTree(target: Extract<ImportTarget, { kind: "github-tree" }>) {
  const ref = await resolveGitHubRef(target);
  const tree = parseGitHubTree(await fetchGitHubJson(
    githubApiUrl(
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    ),
  ));
  const prefix = target.path ? `${target.path}/` : "";
  const entries = tree
    .filter((entry) =>
      entry.type === "blob"
      && entry.path.toLowerCase().endsWith(".scad")
      && (!prefix || entry.path.startsWith(prefix)),
    )
    .map((entry) => ({
      name: safeScadPath(prefix ? entry.path.slice(prefix.length) : entry.path),
      repositoryPath: entry.path,
      size: entry.size,
    }));

  if (!entries.length) {
    throw new ScadImportError("No .scad files were found at that GitHub URL.", 404);
  }
  if (entries.length > maxImportFiles) {
    throw new ScadImportError(`That location contains ${entries.length} .scad files. Choose a folder with at most ${maxImportFiles}.`, 413);
  }
  if (entries.some((entry) => typeof entry.size === "number" && entry.size > maxImportFileBytes)) {
    throw new ScadImportError("One of the OpenSCAD files is larger than 1 MB.", 413);
  }
  const declaredTotalBytes = entries.reduce(
    (total, entry) => total + (typeof entry.size === "number" ? entry.size : 0),
    0,
  );
  if (declaredTotalBytes > maxImportTotalBytes) {
    throw new ScadImportError("The OpenSCAD project is larger than 8 MB.", 413);
  }

  const files: ImportedScadFile[] = [];
  let totalBytes = 0;
  for (let offset = 0; offset < entries.length; offset += 6) {
    const batch = entries.slice(offset, offset + 6);
    const importedBatch = await Promise.all(batch.map((entry) =>
      fetchScadFile(
        entry.name,
        safeRemoteUrl(
          `https://raw.githubusercontent.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/${encodeURIComponent(ref)}/${entry.repositoryPath.split("/").map(encodeURIComponent).join("/")}`,
        ),
      ),
    ));
    totalBytes += importedBatch.reduce(
      (total, file) => total + new TextEncoder().encode(file.source).byteLength,
      0,
    );
    if (totalBytes > maxImportTotalBytes) {
      throw new ScadImportError("The OpenSCAD project is larger than 8 MB.", 413);
    }
    files.push(...importedBatch);
  }
  return files;
}

function chooseMainFile(files: ImportedScadFile[], repositoryName?: string) {
  const rootMain = files.find((file) => file.name.toLowerCase() === "main.scad");
  if (rootMain) return rootMain.name;
  const repositoryFile = repositoryName
    ? files.find((file) => file.name.toLowerCase() === `${repositoryName.toLowerCase()}.scad`)
    : undefined;
  if (repositoryFile) return repositoryFile.name;
  return [...files].sort((left, right) => {
    const leftDepth = left.name.split("/").length;
    const rightDepth = right.name.split("/").length;
    return leftDepth - rightDepth || left.name.length - right.name.length || left.name.localeCompare(right.name);
  })[0].name;
}

export async function importScadFromUrl(request: Request, env: Env) {
  // Fail-open by design: the shared CAD limiter binding is absent in local
  // dev and tests, and imports must keep working there.
  const limited = await enforceRateLimit(
    env.CAD_RATE_LIMITER,
    request,
    "cad-import",
    "SCAD import limit reached. Try again shortly.",
  );
  if (limited) return limited;

  const parsed = await readJsonBody<{ url?: unknown }>(request, 4_096, "The import request is too large.");
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.value.url !== "string" || !parsed.value.url.trim() || parsed.value.url.length > 2_000) {
    return json({ error: "Provide a public SCAD or GitHub URL." }, { status: 400 });
  }

  try {
    const target = parseScadImportTarget(parsed.value.url);
    const files = target.kind === "direct"
      ? [await fetchScadFile(target.name, target.url)]
      : await importGitHubTree(target);
    return json({
      files,
      mainFile: chooseMainFile(files, target.kind === "github-tree" ? target.repository : undefined),
      sourceUrl: parsed.value.url,
    });
  } catch (error) {
    if (error instanceof ScadImportError) {
      return json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      level: "error",
      type: "scad_import_failed",
    }));
    return json({ error: "The remote OpenSCAD project could not be loaded." }, { status: 502 });
  }
}
