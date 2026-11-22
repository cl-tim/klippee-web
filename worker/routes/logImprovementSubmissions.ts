import {
  logImprovementConsentVersion,
  logImprovementSubmissionTtlSeconds,
  maxLogImprovementOriginalBytes,
  maxLogImprovementSubmissionRowsPerUser,
  maxLogImprovementSubmissionBytes,
  maxLogImprovementSubmissionsPerUser,
  uploadReservationTtlSeconds,
} from "../constants";
import { readDb, writeDb } from "../db";
import { json, requireStaticBearerToken, securityHeaders } from "../http";
import { enforcePrincipalRateLimit } from "../rateLimit";
import { LogSubmissionRepository } from "../repositories/LogSubmissionRepository";
import type { Env, LogImprovementSubmissionRow } from "../types";
import {
  enforceUploadRetention,
  isGzipBytes,
  removeExpiredUploads,
  removeUploadRows,
  safeUploadFileName,
  type UploadTable,
} from "../uploadLifecycle";
import { futureIso, nowIso, sha256Hex } from "../util";
import { requireUser } from "./auth";

const submissionUploadTable: UploadTable = { table: "log_improvement_submissions" };

function safeFileName(value: string | null) {
  return safeUploadFileName(value, {
    allowedExtensions: /\.(?:gz|log|txt)$/i,
    decodeUri: true,
    fallback: "klippy.log",
  });
}

function storedFileName(originalFileName: string) {
  return originalFileName.toLowerCase().endsWith(".gz")
    ? originalFileName
    : `${originalFileName}.gz`;
}

function publicSubmission(row: LogImprovementSubmissionRow) {
  return {
    consentVersion: row.consent_version,
    consentedAt: row.consented_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    fileName: row.file_name,
    id: row.id,
    originalFileName: row.original_file_name,
    originalSizeBytes: row.original_size_bytes,
    redactionConfirmed: row.redaction_confirmed === 1,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
  };
}

export async function removeExpiredLogImprovementSubmissions(env: Env, userId?: string) {
  const extraWhere = userId ? { userId } : undefined;
  return removeExpiredUploads(env, submissionUploadTable, extraWhere);
}

function enforceSubmissionRetention(env: Env, userId: string) {
  return enforceUploadRetention(
    env,
    submissionUploadTable,
    { userId },
    maxLogImprovementSubmissionsPerUser,
  );
}

async function gzip(bytes: ArrayBuffer) {
  const compressed = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(compressed).arrayBuffer();
}

async function inspectGzip(bytes: ArrayBuffer) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    let originalSizeBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return { ok: true as const, originalSizeBytes };
      }

      originalSizeBytes += value.byteLength;
      if (originalSizeBytes > maxLogImprovementOriginalBytes) {
        try {
          await reader.cancel();
        } catch {
          // The expanded-size decision is already final; cancellation is best-effort.
        }
        return { ok: false as const, reason: "too-large" as const };
      }
    }
  } catch {
    return { ok: false as const, reason: "invalid" as const };
  } finally {
    reader?.releaseLock();
  }
}

export async function createLogImprovementSubmission(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;

  if (!env.LOG_IMPROVEMENT_REVIEW_TOKEN?.trim()) {
    return json({ error: "Log improvement review access is not configured" }, { status: 503 });
  }

  if (
    request.headers.get("x-klippee-consent-version") !== logImprovementConsentVersion
    || request.headers.get("x-klippee-redaction-confirmed") !== "1"
  ) {
    return json(
      { error: "Explicit sharing and redaction consent is required" },
      { status: 400 },
    );
  }

  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = Number(contentLengthHeader);
  if (!contentLengthHeader || !Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return json({ error: "Log submission requires a valid Content-Length" }, { status: 411 });
  }
  if (contentLength > maxLogImprovementSubmissionBytes) {
    return json({ error: "Compressed log submission exceeds the 16 MiB limit" }, { status: 413 });
  }

  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!["application/gzip", "application/octet-stream", "text/plain"].includes(contentType)) {
    return json({ error: "Log submission must be plain text or gzip" }, { status: 415 });
  }

  const userHash = await sha256Hex(user.id);
  const limited = await enforcePrincipalRateLimit(
    env.LOG_IMPROVEMENT_RATE_LIMITER,
    `log-improvement:${userHash}`,
    {
      error: "Too many log improvement submissions for this account. Retry after 60 seconds.",
      resource: "log-improvement-submissions",
    },
  );
  if (limited) return limited;

  const requestBytes = await request.arrayBuffer();
  if (!requestBytes.byteLength) {
    return json({ error: "Log submission is empty" }, { status: 400 });
  }
  if (requestBytes.byteLength > maxLogImprovementSubmissionBytes) {
    return json({ error: "Compressed log submission exceeds the 16 MiB limit" }, { status: 413 });
  }

  const originalFileName = safeFileName(request.headers.get("x-klippee-log-name"));
  const declaredAsGzip = contentType === "application/gzip" || originalFileName.toLowerCase().endsWith(".gz");
  const suppliedAsGzip = isGzipBytes(requestBytes);
  if (declaredAsGzip && !suppliedAsGzip) {
    return json({ error: "Log submission is not valid gzip data" }, { status: 400 });
  }

  const gzipInspection = suppliedAsGzip ? await inspectGzip(requestBytes) : null;
  if (gzipInspection && !gzipInspection.ok) {
    return gzipInspection.reason === "too-large"
      ? json({ error: "Expanded log submission exceeds the 64 MiB limit" }, { status: 413 })
      : json({ error: "Log submission is not valid gzip data" }, { status: 400 });
  }
  const originalSizeBytes = gzipInspection?.originalSizeBytes ?? requestBytes.byteLength;
  const compressedBytes = suppliedAsGzip ? requestBytes : await gzip(requestBytes);
  if (compressedBytes.byteLength > maxLogImprovementSubmissionBytes) {
    return json({ error: "Compressed log submission exceeds the 16 MiB limit" }, { status: 413 });
  }

  const id = crypto.randomUUID();
  const timestamp = nowIso();
  const expiresAt = futureIso(logImprovementSubmissionTtlSeconds);
  const reservationExpiresAt = futureIso(uploadReservationTtlSeconds);
  const fileName = storedFileName(originalFileName);
  const key = `diagnostic-improvements/${id}/${fileName}`;
  const sha256 = await sha256Hex(new Uint8Array(compressedBytes));

  await removeExpiredLogImprovementSubmissions(env, user.id);
  await enforceSubmissionRetention(env, user.id);

  const stored = await LogSubmissionRepository.reserve(writeDb(env), {
    id, userId: user.id, originalFileName, fileName, originalSizeBytes, sha256, r2Key: key,
    consentVersion: logImprovementConsentVersion, consentedAt: timestamp, createdAt: timestamp, expiresAt: reservationExpiresAt,
  }, maxLogImprovementSubmissionRowsPerUser);
  if ((stored.meta.changes ?? 0) !== 1) {
    return json(
      { error: "Log improvement submission retention is busy. Retry shortly." },
      { headers: { "retry-after": "5" }, status: 503 },
    );
  }

  const reservedRow = { id, r2_key: key };
  try {
    await env.BLOBS.put(key, compressedBytes, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: {
        consentVersion: logImprovementConsentVersion,
        expiresAt,
        originalFileName,
      },
    });
  } catch (error) {
    await removeUploadRows(env, submissionUploadTable, [reservedRow]);
    throw error;
  }

  const finalized = await LogSubmissionRepository.finalize(writeDb(env), id, key, compressedBytes.byteLength, expiresAt);
  if ((finalized.meta.changes ?? 0) !== 1) {
    await removeUploadRows(env, submissionUploadTable, [reservedRow]);
    return json(
      { error: "Log improvement submission retention changed while uploading. Retry shortly." },
      { headers: { "retry-after": "5" }, status: 503 },
    );
  }

  await enforceSubmissionRetention(env, user.id);
  return json({
    submission: publicSubmission({
      consent_version: logImprovementConsentVersion,
      consented_at: timestamp,
      created_at: timestamp,
      expires_at: expiresAt,
      file_name: fileName,
      id,
      original_file_name: originalFileName,
      original_size_bytes: originalSizeBytes,
      r2_key: key,
      redaction_confirmed: 1,
      sha256,
      size_bytes: compressedBytes.byteLength,
      user_id: user.id,
    }),
  }, { status: 201 });
}

export async function deleteLogImprovementSubmission(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const row = await LogSubmissionRepository.getObjectForOwner(writeDb(env), id, user.id);
  if (!row) return json({ error: "Log improvement submission not found" }, { status: 404 });
  await removeUploadRows(env, submissionUploadTable, [row]);
  return json({ ok: true });
}

function requireReviewer(request: Request, env: Env) {
  return requireStaticBearerToken(request, env.LOG_IMPROVEMENT_REVIEW_TOKEN, {
    notConfigured: "Log improvement review access is not configured",
    unauthorized: "Reviewer authentication required",
  });
}

export async function listLogImprovementSubmissionsForReview(request: Request, env: Env, url: URL) {
  const authResponse = await requireReviewer(request, env);
  if (authResponse) return authResponse;
  const pageValue = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const limit = 100;
  const result = await LogSubmissionRepository.listForReview(readDb(env), nowIso(), limit, (page - 1) * limit);
  const submissions = result.map((row) => ({
    ...publicSubmission(row),
    downloadPath: `/api/internal/log-improvement-submissions/${encodeURIComponent(row.id)}`,
  }));
  return json({
    nextPage: submissions.length === limit ? page + 1 : null,
    submissions,
  });
}

export async function getLogImprovementSubmissionForReview(request: Request, env: Env, id: string) {
  const authResponse = await requireReviewer(request, env);
  if (authResponse) return authResponse;
  const row = await LogSubmissionRepository.getForReview(readDb(env), id, nowIso());
  if (!row) return json({ error: "Log improvement submission not found" }, { status: 404 });
  const object = await env.BLOBS.get(row.r2_key);
  if (!object) return json({ error: "Log improvement submission data is unavailable" }, { status: 404 });
  return new Response(object.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${row.file_name.replace(/"/g, "_")}"`,
      "content-length": String(row.size_bytes),
      "content-type": "application/gzip",
      "x-klippee-sha256": row.sha256,
      ...securityHeaders(),
    },
  });
}
