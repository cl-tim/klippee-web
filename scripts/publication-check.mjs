import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";

// Report locations and categories only. Never print potentially private values.
// This guardrail complements human review, OCR/image review and a secret scanner;
// it cannot prove that arbitrary text, images or GitHub metadata are safe.
const history = process.argv.includes("--history");
const forbiddenPath = /^(?:artifacts\/|\.claude\/|\.codex-attachments\/|\.wrangler\/|reference\/|self-hosted\/data\/|docs\/user-guide\/images\/|wrangler\.json$)|(?:^|\/)(?:\.env|\.dev\.vars)(?!\.example$)(?:\.|$)|^plugins\/orcaslicer\/.*-result\.json$/i;
const privateName = /\bqidi[1-9]\d*\b/i;
const credential = /(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/;
const network = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.(?:local|lan|home|internal)|[a-z0-9.-]+\.ts\.net)\b/i;
const findings = new Set();
let scanned = 0;
function scan(path, data) {
  scanned += 1;
  if (forbiddenPath.test(path)) findings.add(`${path}: private/generated file`);
  if (data.subarray(0, 8192).includes(0)) return;
  const source = data.toString("utf8");
  if (privateName.test(source)) findings.add(`${path}: printer identifier`);
  if (credential.test(source)) findings.add(`${path}: credential pattern`);
  // Network-address fixtures are intentional in safety and SSRF tests.
  // Ordinary code that handles .local names is not an embedded endpoint.
  const testFile = /(?:^tests\/|\.test\.[cm]?[jt]sx?$)/.test(path);
  if (!testFile && !["scripts/smoke-prod.mjs", "scripts/publication-check.mjs"].includes(path)) {
    const endpoints = source.match(/(?:https?:\/\/|(?:host|hostname|address)\s*[:=]\s*["']?)[^\s"'<>]+/gi) ?? [];
    if (endpoints.some((value) => network.test(value))) findings.add(`${path}: private network endpoint`);
  }
}

if (history) {
  const paths = execFileSync("git", ["rev-list", "--objects", "--all"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim().split("\n")
    .filter((line) => line.includes(" ")).map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]);
  const child = spawn("git", ["cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
  let pending = Buffer.alloc(0);
  const output = child.stdout[Symbol.asyncIterator]();
  for (const [oid, path] of paths) {
    if (!child.stdin.write(`${oid}\n`)) await once(child.stdin, "drain");
    while (pending.indexOf(10) === -1) pending = Buffer.concat([pending, (await output.next()).value]);
    const end = pending.indexOf(10);
    const [, type, length] = pending.subarray(0, end).toString().split(" ");
    const size = Number(length);
    pending = pending.subarray(end + 1);
    while (pending.length < size + 1) pending = Buffer.concat([pending, (await output.next()).value]);
    if (type === "blob") scan(path, pending.subarray(0, size));
    pending = pending.subarray(size + 1);
  }
  child.stdin.end();
  await once(child, "close");
  const messages = execFileSync("git", ["log", "--all", "--format=%B"], { maxBuffer: 64 * 1024 * 1024 });
  scan("Git commit messages", messages);
} else {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  for (const path of paths) {
    try { scan(path, await readFile(path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
for (const finding of [...findings].sort()) console.error(finding);
console.log(`Publication check: ${scanned} ${history ? "historical objects" : "tracked files"}, ${findings.size} finding locations`);
if (findings.size) process.exitCode = 1;
