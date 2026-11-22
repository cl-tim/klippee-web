import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deploymentOrigin } from "./deployment-origin.mjs";

const apply = process.argv.includes("--apply");
const inventoryOnly = process.argv.includes("--inventory-only");
const resume = process.argv.includes("--resume");
const confirmation = readOption("--confirm", "");
const token = process.env.KLIPPEE_STORAGE_MAINTENANCE_TOKEN?.trim();
if (!token) {
  console.error("Set KLIPPEE_STORAGE_MAINTENANCE_TOKEN before running the storage inventory.");
  process.exit(1);
}
if (apply && confirmation !== "RECLAIM-CANONICAL-BLOBS") {
  console.error("Apply mode requires --confirm RECLAIM-CANONICAL-BLOBS.");
  process.exit(1);
}

const origin = deploymentOrigin(readOption("--origin", process.env.KLIPPEE_ORIGIN), "Set KLIPPEE_ORIGIN or pass --origin.");
const outputFile = resolve(readOption("--output", "storage-inventory.json"));
const headers = { authorization: `Bearer ${token}` };

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function fetchJson(path, init) {
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `${path} failed with HTTP ${response.status}`);
  }
  return body;
}

async function collectCursorPages(path, field) {
  const rows = [];
  let cursor = "";
  do {
    const url = new URL(path, origin);
    if (cursor) url.searchParams.set("cursor", cursor);
    const body = await fetchJson(url);
    if (!Array.isArray(body?.[field])) throw new Error(`${path} returned an invalid ${field} page`);
    rows.push(...body[field]);
    cursor = typeof body.cursor === "string" ? body.cursor : "";
  } while (cursor);
  return rows;
}

async function collectAfterPages(path, field) {
  const rows = [];
  let after = "";
  do {
    const url = new URL(path, origin);
    if (after) url.searchParams.set("after", after);
    const body = await fetchJson(url);
    if (!Array.isArray(body?.[field])) throw new Error(`${path} returned an invalid ${field} page`);
    rows.push(...body[field]);
    after = typeof body.nextAfter === "string" ? body.nextAfter : "";
  } while (after);
  return rows;
}

async function collectReclaimState() {
  const candidates = [];
  let events = [];
  let after = "";
  let firstPage = true;
  do {
    const url = new URL("/api/internal/storage/reclaims", origin);
    if (after) url.searchParams.set("after", after);
    const body = await fetchJson(url);
    if (!Array.isArray(body?.candidates) || !Array.isArray(body?.events)) {
      throw new Error("Storage reclamation state returned an invalid page");
    }
    candidates.push(...body.candidates);
    if (firstPage) events = body.events;
    firstPage = false;
    after = typeof body.nextAfter === "string" ? body.nextAfter : "";
  } while (after);
  return { candidates, events };
}

function summarizeNamespaces(objects) {
  const summaries = new Map();
  for (const object of objects) {
    const current = summaries.get(object.namespace) ?? { bytes: 0, objects: 0 };
    current.bytes += Number(object.sizeBytes) || 0;
    current.objects += 1;
    summaries.set(object.namespace, current);
  }
  return Object.fromEntries([...summaries.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function chunks(values, size) {
  const output = [];
  for (let offset = 0; offset < values.length; offset += size) {
    output.push(values.slice(offset, offset + size));
  }
  return output;
}

async function planOrApply(hashes, activeCandidates) {
  const results = [];
  for (const batch of chunks(hashes, 10)) {
    const resumeTokens = {};
    if (resume) {
      for (const hash of batch) {
        const tokenValue = activeCandidates.get(hash)?.delete_token;
        if (typeof tokenValue === "string") resumeTokens[hash] = tokenValue;
      }
    }
    const body = await fetchJson("/api/internal/storage/reclaims", {
      body: JSON.stringify({ apply, hashes: batch, resumeTokens }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!Array.isArray(body?.results)) throw new Error("Storage reclamation returned an invalid response");
    results.push(...body.results);
  }
  return results;
}

const [objects, canonicalReferences, legacyReferences, reclaimState] = await Promise.all([
  collectCursorPages("/api/internal/storage/objects", "objects"),
  collectAfterPages("/api/internal/storage/canonical-references", "references"),
  collectAfterPages("/api/internal/storage/legacy-references", "references"),
  collectReclaimState(),
]);

const canonicalObjects = objects.filter((object) => object.namespace === "canonical-blobs");
const objectByKey = new Map(objects.map((object) => [object.key, object]));
const referenceByHash = new Map(canonicalReferences.map((reference) => [reference.sha256, reference]));
const activeCandidates = new Map(
  (reclaimState.candidates ?? [])
    .filter((candidate) => candidate.delete_token && candidate.sha256)
    .map((candidate) => [candidate.sha256, candidate]),
);

const physicalOrphans = canonicalObjects.filter((object) => {
  const hash = object.key.slice("blobs/sha256/".length);
  const reference = referenceByHash.get(hash);
  return !reference || (reference.referenceCount === 0 && reference.manifestReferenceCount === 0);
});
const missingReferenced = canonicalReferences.filter((reference) => (
  (reference.referenceCount > 0 || reference.manifestReferenceCount > 0)
  && !objectByKey.has(`blobs/sha256/${reference.sha256}`)
));
const unreferencedLedger = canonicalReferences.filter((reference) => (
  reference.ledgerPresent
  && reference.reclaimable
  && reference.referenceCount === 0
  && reference.manifestReferenceCount === 0
));
const claimOnlyState = canonicalReferences.filter((reference) => (
  !reference.ledgerPresent
  && reference.reclaimable
  && reference.claimCount > 0
  && reference.referenceCount === 0
  && reference.manifestReferenceCount === 0
));
const leaseOnlyState = canonicalReferences.filter((reference) => (
  !reference.ledgerPresent
  && reference.reclaimable
  && reference.activeLeaseCount > 0
  && reference.referenceCount === 0
  && reference.manifestReferenceCount === 0
));
const referenceDrift = canonicalReferences.filter((reference) => (
  reference.manifestOnlyReferenceCount > 0 || reference.normalizedOnlyReferenceCount > 0
));
const ledgerMissing = canonicalReferences.filter((reference) => !reference.ledgerPresent);
const malformedLedger = canonicalReferences.filter((reference) => !reference.reclaimable);
const legacyMissing = legacyReferences.filter((reference) => !objectByKey.has(reference.key));
const physicalLegacyUnreferenced = objects.filter((object) => (
  object.namespace === "legacy-repository-snapshots"
  && !legacyReferences.some((reference) => reference.key === object.key)
));

const candidateHashes = new Set([
  ...physicalOrphans.map((object) => object.key.slice("blobs/sha256/".length)),
  ...unreferencedLedger.map((reference) => reference.sha256),
  ...claimOnlyState.map((reference) => reference.sha256),
  ...leaseOnlyState.map((reference) => reference.sha256),
]);
if (resume) {
  for (const hash of activeCandidates.keys()) candidateHashes.add(hash);
}

const reclamationResults = inventoryOnly || candidateHashes.size === 0
  ? []
  : await planOrApply([...candidateHashes].sort(), activeCandidates);

const report = {
  canonical: {
    claimOnlyState,
    ledgerMissing,
    ledgerRows: canonicalReferences.filter((reference) => reference.ledgerPresent).length,
    malformedLedger,
    missingReferenced,
    physicalObjects: canonicalObjects.length,
    physicalOrphans,
    referenceDrift,
    leaseOnlyState,
    unreferencedLedger,
  },
  generatedAt: new Date().toISOString(),
  legacyV1: {
    missingReferenced: legacyMissing,
    physicalUnreferenced: physicalLegacyUnreferenced,
    references: legacyReferences,
  },
  namespaces: summarizeNamespaces(objects),
  origin: origin.origin,
  reclamation: {
    applied: apply,
    inventoryOnly,
    results: reclamationResults,
    resumed: resume,
  },
  reclaims: reclaimState,
};

await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

console.log(`R2 inventory: ${objects.length} objects across ${Object.keys(report.namespaces).length} namespaces`);
console.log(`Canonical: ${canonicalObjects.length} physical, ${physicalOrphans.length} orphaned, ${missingReferenced.length} missing referenced`);
console.log(`Reference drift: ${referenceDrift.length}; ledger missing: ${ledgerMissing.length}; malformed ledger: ${malformedLedger.length}; legacy v1 missing: ${legacyMissing.length}`);
console.log(`Detached accounting: ${claimOnlyState.length} claim-only, ${leaseOnlyState.length} lease-only`);
if (!inventoryOnly) {
  const statusCounts = reclamationResults.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, {});
  console.log(`${apply ? "Apply" : "Dry-run"} results: ${JSON.stringify(statusCounts)}`);
}
console.log(`Saved protected inventory details to ${outputFile}`);
