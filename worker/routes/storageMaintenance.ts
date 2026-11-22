import {
  canonicalBlobReclaimGraceSeconds,
  maxCanonicalBlobReclaimsPerRequest,
} from "../constants";
import { writeDb } from "../db";
import { StorageMaintenanceRepository, type CandidateRow } from "../repositories/StorageMaintenanceRepository";
import { unwrapDatabaseError } from "../databaseErrors";
import { json, readJsonBody, requireStaticBearerToken } from "../http";
import type { Env } from "../types";
import { futureIso, isRecord, nowIso } from "../util";

const canonicalBlobPrefix = "blobs/sha256/";
const canonicalHashPattern = /^[0-9a-f]{64}$/;

type ReclaimInput = {
  apply: boolean;
  hashes: string[];
  resumeTokens: Record<string, string>;
};

function canonicalKey(hash: string) {
  return `${canonicalBlobPrefix}${hash}`;
}

function storageNamespace(key: string) {
  if (key.startsWith(canonicalBlobPrefix)) {
    return canonicalHashPattern.test(key.slice(canonicalBlobPrefix.length))
      ? "canonical-blobs"
      : "malformed-canonical";
  }
  if (/^repositories\/[^/]+\/versions\/sha256\/[^/]+\.json$/.test(key)) {
    return "legacy-repository-snapshots";
  }
  if (key.startsWith("diagnostics/")) return "diagnostics";
  if (key.startsWith("diagnostic-improvements/")) return "diagnostic-improvements";
  if (key.startsWith("artifacts/rendered-zips/")) return "legacy-rendered-zips";
  if (key.startsWith("snapshots/")) return "snapshots";
  if (key.startsWith("imports/")) return "imports";
  return "unknown";
}

function requireStorageOperator(request: Request, env: Env) {
  return requireStaticBearerToken(request, env.STORAGE_MAINTENANCE_TOKEN, {
    notConfigured: "Storage maintenance access is not configured",
    unauthorized: "Storage maintenance authentication required",
  });
}

function uploadedIso(object: R2Object | null) {
  return object?.uploaded instanceof Date ? object.uploaded.toISOString() : null;
}

function publicCandidate(row: CandidateRow | null) {
  if (!row) return null;
  return {
    deleteStartedAt: row.delete_started_at,
    deleteToken: row.delete_token,
    firstSeenAt: row.first_seen_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    objectEtag: row.object_etag,
    objectSizeBytes: row.object_size_bytes,
    objectUploadedAt: row.object_uploaded_at,
    objectVersion: row.object_version,
    reclaimAfter: row.reclaim_after,
  };
}

async function canonicalState(env: Env, hash: string) {
  return StorageMaintenanceRepository.state(writeDb(env), hash, nowIso());
}

async function getCandidate(env: Env, key: string) {
  return StorageMaintenanceRepository.getCandidate(writeDb(env), key);
}

export async function listStorageObjectsForMaintenance(request: Request, env: Env, url: URL) {
  const authResponse = await requireStorageOperator(request, env);
  if (authResponse) return authResponse;
  const cursorValue = url.searchParams.get("cursor")?.trim() ?? "";
  if (cursorValue.length > 2_048) {
    return json({ error: "R2 inventory cursor is too long" }, { status: 400 });
  }
  const listing = await env.BLOBS.list({
    ...(cursorValue ? { cursor: cursorValue } : {}),
    include: ["customMetadata", "httpMetadata"],
    limit: 1_000,
  });
  return json({
    cursor: listing.truncated ? listing.cursor : null,
    objects: listing.objects.map((object) => ({
      customMetadata: object.customMetadata,
      etag: object.etag,
      key: object.key,
      namespace: storageNamespace(object.key),
      sizeBytes: object.size,
      storageClass: object.storageClass,
      uploadedAt: object.uploaded.toISOString(),
      version: object.version,
    })),
  });
}

export async function listCanonicalReferencesForMaintenance(request: Request, env: Env, url: URL) {
  const authResponse = await requireStorageOperator(request, env);
  if (authResponse) return authResponse;
  const after = url.searchParams.get("after") ?? "";
  if (after.length > 2_048) {
    return json({ error: "Canonical reference cursor is too long" }, { status: 400 });
  }
  const rows = await StorageMaintenanceRepository.listCanonicalReferences(writeDb(env), after, nowIso());
  return json({
    nextAfter: rows.length === 500 ? rows.at(-1)?.sha256 ?? null : null,
    references: rows.map((row) => ({
      activeLeaseCount: row.active_lease_count,
      chargeBytes: row.charge_bytes,
      claimCount: row.claim_count,
      createdAt: row.created_at,
      ledgerPresent: row.size_bytes !== null,
      manifestReferenceCount: row.manifest_reference_count,
      manifestOnlyReferenceCount: row.manifest_only_reference_count,
      normalizedOnlyReferenceCount: row.normalized_only_reference_count,
      ownerCount: row.owner_count,
      reclaimable: typeof row.sha256 === "string" && canonicalHashPattern.test(row.sha256),
      referenceCount: row.reference_count,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      storedAt: row.stored_at,
    })),
  });
}

export async function listLegacyReferencesForMaintenance(request: Request, env: Env, url: URL) {
  const authResponse = await requireStorageOperator(request, env);
  if (authResponse) return authResponse;
  const after = url.searchParams.get("after") ?? "";
  if (after.length > 1_024) {
    return json({ error: "Legacy reference cursor is too long" }, { status: 400 });
  }
  const rows = await StorageMaintenanceRepository.listLegacyReferences(writeDb(env), after);
  return json({
    nextAfter: rows.length === 500 ? rows.at(-1)?.r2_key ?? null : null,
    references: rows.map((row) => ({
      key: row.r2_key,
      ownerCount: row.owner_count,
      referenceCount: row.reference_count,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
    })),
  });
}

export async function listCanonicalReclaimsForMaintenance(request: Request, env: Env, url: URL) {
  const authResponse = await requireStorageOperator(request, env);
  if (authResponse) return authResponse;
  const after = url.searchParams.get("after") ?? "";
  if (after.length > 1_024) {
    return json({ error: "Reclamation candidate cursor is too long" }, { status: 400 });
  }
  const [candidates, events] = await StorageMaintenanceRepository.listReclaims(writeDb(env), after);
  return json({
    candidates,
    events,
    nextAfter: candidates.length === 500 ? candidates.at(-1)?.r2_key ?? null : null,
  });
}

function parseReclaimInput(value: unknown): ReclaimInput | null {
  if (!isRecord(value) || !Array.isArray(value.hashes) || value.hashes.length > maxCanonicalBlobReclaimsPerRequest) {
    return null;
  }
  const hashes = [...new Set(value.hashes)];
  if (!hashes.every((hash): hash is string => typeof hash === "string" && canonicalHashPattern.test(hash))) {
    return null;
  }
  const resumeTokens: Record<string, string> = {};
  if (value.resumeTokens !== undefined) {
    if (!isRecord(value.resumeTokens)) return null;
    for (const [hash, token] of Object.entries(value.resumeTokens)) {
      if (!canonicalHashPattern.test(hash) || typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) {
        return null;
      }
      resumeTokens[hash] = token;
    }
  }
  return { apply: value.apply === true, hashes, resumeTokens };
}

async function observeCandidate(env: Env, hash: string) {
  const key = canonicalKey(hash);
  const [state, object] = await Promise.all([canonicalState(env, hash), env.BLOBS.head(key)]);
  if (!state) throw new Error("Canonical blob state query failed");
  const existing = await getCandidate(env, key);
  if (existing?.delete_token) {
    if (
      state.normalized_references > 0
      || state.manifest_references > 0
      || state.active_leases > 0
    ) {
      return {
        candidate: existing,
        object,
        state,
        status: "deletion_fence_conflict" as const,
      };
    }
    return {
      candidate: existing,
      object,
      state,
      status: "deletion_in_progress" as const,
    };
  }
  if (state.normalized_references > 0 || state.manifest_references > 0) {
    if (existing) {
      await StorageMaintenanceRepository.removeUnfenced(writeDb(env), key);
    }
    return { candidate: null, object, state, status: "referenced" as const };
  }
  if (state.active_leases > 0) {
    if (existing) {
      await StorageMaintenanceRepository.removeUnfenced(writeDb(env), key);
    }
    return { candidate: null, object, state, status: "write_in_progress" as const };
  }
  if (!object && state.canonical_size_bytes === null && state.claim_count === 0) {
    return { candidate: existing, object, state, status: "not_found" as const };
  }

  const timestamp = nowIso();
  const reclaimAfter = futureIso(canonicalBlobReclaimGraceSeconds);
  await StorageMaintenanceRepository.observe(writeDb(env), {
    r2Key: key, sha256: hash, firstSeenAt: timestamp, lastCheckedAt: timestamp, reclaimAfter,
    objectSizeBytes: object?.size ?? null, objectEtag: object?.etag ?? null,
    objectVersion: object?.version ?? null, objectUploadedAt: uploadedIso(object),
  });

  const candidate = await getCandidate(env, key);
  if (!candidate) {
    return { candidate: null, object, state, status: "changed_during_observation" as const };
  }
  return {
    candidate,
    object,
    state,
    status: candidate.reclaim_after <= timestamp ? "eligible" as const : "observing" as const,
  };
}

function sameObject(candidate: CandidateRow, object: R2Object) {
  if (candidate.object_version === null) return false;
  return Boolean(
    object.version === candidate.object_version
    && object.etag === candidate.object_etag
    && object.size === candidate.object_size_bytes
    && uploadedIso(object) === candidate.object_uploaded_at,
  );
}

async function markReclaimError(env: Env, candidate: CandidateRow, message: string) {
  await StorageMaintenanceRepository.markError(writeDb(env), candidate, message.slice(0, 1_000), nowIso());
}

async function acquireReclaimFence(env: Env, candidate: CandidateRow) {
  return StorageMaintenanceRepository.acquireFence(writeDb(env), candidate, crypto.randomUUID(), nowIso());
}

async function finalizeReclaim(env: Env, candidate: CandidateRow, outcome: "already_missing" | "deleted") {
  return StorageMaintenanceRepository.finalize(writeDb(env), candidate, outcome, nowIso());
}

async function applyReclaim(
  env: Env,
  hash: string,
  observed: Awaited<ReturnType<typeof observeCandidate>>,
  resumeToken: string | undefined,
) {
  let candidate = observed.candidate;
  if (!candidate) return { status: observed.status };
  if (candidate.delete_token) {
    if (observed.status !== "deletion_in_progress") {
      return { candidate: publicCandidate(candidate), status: observed.status };
    }
    if (!resumeToken || resumeToken !== candidate.delete_token) {
      return { candidate: publicCandidate(candidate), status: "deletion_in_progress" };
    }
  } else {
    if (observed.status !== "eligible") {
      return { candidate: publicCandidate(candidate), status: observed.status };
    }
    candidate = await acquireReclaimFence(env, candidate);
    if (!candidate) {
      return { status: "changed_before_fence" };
    }
  }

  try {
    const finalObject = await env.BLOBS.head(candidate.r2_key);
    if (env.LOCAL_AUTH_BYPASS === "1" && env.STORAGE_RECLAIM_TEST_HOOK) {
      const hookResponse = await env.STORAGE_RECLAIM_TEST_HOOK.fetch(
        `https://storage-reclaim.test/after-head/${hash}`,
        { method: "POST" },
      );
      if (!hookResponse.ok) throw new Error("Storage reclamation test hook failed");
    }
    // Absence is a valid fenced state: an earlier attempt may have completed
    // the R2 delete and crashed before its guarded D1 finalization. A present
    // object must still match the exact pre-fence snapshot.
    if (finalObject && !sameObject(candidate, finalObject)) {
      await markReclaimError(env, candidate, "R2 object metadata changed after the deletion fence was acquired");
      return { candidate: publicCandidate(candidate), status: "object_changed_after_fence" };
    }
    const outcome = finalObject ? "deleted" as const : "already_missing" as const;
    if (finalObject) {
      await env.BLOBS.delete(candidate.r2_key);
    }
    if (await env.BLOBS.head(candidate.r2_key)) {
      await markReclaimError(env, candidate, "R2 object remained present after delete");
      return { candidate: publicCandidate(candidate), status: "delete_not_confirmed" };
    }
    if (!await finalizeReclaim(env, candidate, outcome)) {
      await markReclaimError(env, candidate, "D1 finalization did not release the deletion fence");
      return { candidate: publicCandidate(candidate), status: "finalization_pending" };
    }
    return { outcome, status: "reclaimed" };
  } catch (caught) {
    const error = unwrapDatabaseError(caught);
    const message = error instanceof Error ? error.message : String(error);
    await markReclaimError(env, candidate, message);
    return { candidate: publicCandidate(candidate), error: message, status: "reclamation_failed" };
  }
}

export async function applyCanonicalBlobReclaim(
  env: Env,
  hash: string,
  resumeToken: string | undefined,
) {
  if (!canonicalHashPattern.test(hash)) {
    return { status: "invalid_hash" as const };
  }
  const observed = await observeCandidate(env, hash);
  return applyReclaim(env, hash, observed, resumeToken);
}

export async function reclaimCanonicalBlobsForMaintenance(request: Request, env: Env) {
  const authResponse = await requireStorageOperator(request, env);
  if (authResponse) return authResponse;
  const parsedBody = await readJsonBody<unknown>(request, 16_384, "Storage maintenance request is too large");
  if (!parsedBody.ok) return parsedBody.response;
  const input = parseReclaimInput(parsedBody.value);
  if (!input || input.hashes.length === 0) {
    return json(
      { error: `Provide between 1 and ${maxCanonicalBlobReclaimsPerRequest} distinct lowercase SHA-256 hashes` },
      { status: 400 },
    );
  }

  const results = [];
  for (const hash of input.hashes) {
    if (input.apply) {
      const result = await env.CANONICAL_BLOB_RECLAIMER
        .getByName(hash)
        .reclaim(hash, input.resumeTokens[hash] ?? null);
      results.push({ hash, ...result });
      continue;
    }

    const observed = await observeCandidate(env, hash);
    results.push({
      candidate: publicCandidate(observed.candidate),
      hash,
      objectPresent: Boolean(observed.object),
      state: {
        activeLeases: observed.state.active_leases,
        claimCount: observed.state.claim_count,
        manifestReferences: observed.state.manifest_references,
        normalizedReferences: observed.state.normalized_references,
      },
      status: observed.status,
    });
  }
  return json({ apply: input.apply, results });
}
