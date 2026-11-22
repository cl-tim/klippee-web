import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deploymentOrigin } from "./deployment-origin.mjs";

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function safeSegment(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "klippy.log.gz";
}

const token = process.env.KLIPPEE_REVIEW_TOKEN?.trim();
if (!token) {
  console.error("Set KLIPPEE_REVIEW_TOKEN to the protected review token before downloading submissions.");
  process.exit(1);
}

const origin = deploymentOrigin(readOption("--origin", process.env.KLIPPEE_ORIGIN), "Set KLIPPEE_ORIGIN or pass --origin.");
const outputDirectory = resolve(readOption("--output", "log-improvement-submissions"));
const headers = { authorization: `Bearer ${token}` };
const submissions = [];
let page = 1;

while (page) {
  const listUrl = new URL("/api/internal/log-improvement-submissions", origin);
  listUrl.searchParams.set("page", String(page));
  const response = await fetch(listUrl, { headers });
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body?.submissions)) {
    throw new Error(body?.error ?? `Could not list submissions (HTTP ${response.status}).`);
  }
  submissions.push(...body.submissions);
  page = Number.isSafeInteger(body.nextPage) ? body.nextPage : 0;
}

await mkdir(outputDirectory, { recursive: true });
const downloaded = [];
for (const submission of submissions) {
  const response = await fetch(new URL(submission.downloadPath, origin), { headers });
  if (!response.ok) {
    throw new Error(`Could not download submission ${submission.id} (HTTP ${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== submission.sha256) {
    throw new Error(`Checksum mismatch for submission ${submission.id}.`);
  }
  const timestamp = submission.createdAt.replace(/[:.]/g, "-");
  const localFile = `${timestamp}_${safeSegment(submission.id)}_${safeSegment(submission.fileName)}`;
  await writeFile(resolve(outputDirectory, localFile), bytes);
  downloaded.push({ ...submission, localFile });
  console.log(`downloaded ${submission.originalFileName} -> ${localFile}`);
}

await writeFile(
  resolve(outputDirectory, "manifest.json"),
  `${JSON.stringify({ downloadedAt: new Date().toISOString(), origin: origin.origin, submissions: downloaded }, null, 2)}\n`,
  "utf8",
);
console.log(`saved ${downloaded.length} compressed submission(s) to ${outputDirectory}`);
