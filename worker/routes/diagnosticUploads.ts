import {
  diagnosticUploadTtlSeconds,
  maxDiagnosticUploadBytes,
  maxDiagnosticUploadRowsPerPrinter,
  maxDiagnosticUploadsPerPrinter,
  uploadReservationTtlSeconds,
} from "../constants";
import { readDb, writeDb } from "../db";
import { json, securityHeaders } from "../http";
import { enforcePrincipalRateLimit } from "../rateLimit";
import { DiagnosticUploadRepository } from "../repositories/DiagnosticUploadRepository";
import type { DiagnosticUploadRow, Env } from "../types";
import {
  enforceUploadRetention,
  isGzipBytes,
  isZipBytes,
  removeExpiredUploads,
  removeUploadObjects,
  removeUploadRows,
  safeUploadFileName,
  type UploadTable,
} from "../uploadLifecycle";
import { futureIso, nowIso, sha256Hex } from "../util";
import { requireUser } from "./auth";
import { requireSyncToken } from "./sync";

const diagnosticUploadTable: UploadTable = { table: "diagnostic_uploads" };

function safeFileName(value: string | null) {
  return safeUploadFileName(value, {
    allowedExtensions: /\.(?:gz|log|txt|zip)$/i,
    fallback: "klippy.log.gz",
  });
}

function publicUpload(row: DiagnosticUploadRow) {
  return {
    contentType: row.content_type,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    fileName: row.file_name,
    id: row.id,
    originalSizeBytes: row.original_size_bytes,
    printerId: row.printer_id,
    printerName: row.printer_name ?? "Printer",
    repositoryId: row.repository_id,
    sizeBytes: row.size_bytes,
    truncated: row.truncated === 1,
  };
}

export async function removeDiagnosticObjects(env: Env, keys: string[]) {
  return removeUploadObjects(env, keys);
}

export async function removeExpiredDiagnosticUploads(env: Env, userId?: string, printerId?: string) {
  const extraWhere = userId ? { userId, ...(printerId ? { printerId } : {}) } : undefined;
  return removeExpiredUploads(env, diagnosticUploadTable, extraWhere);
}

function enforceDiagnosticRetention(env: Env, userId: string, printerId: string) {
  return enforceUploadRetention(
    env,
    diagnosticUploadTable,
    { userId, printerId },
    maxDiagnosticUploadsPerPrinter,
  );
}

async function syncTokenStillOwnsPrinter(
  env: Env,
  tokenId: string,
  userId: string,
  repositoryId: string,
  printerId: string,
) {
  return DiagnosticUploadRepository.hasOwnership(writeDb(env), { tokenId, userId, repositoryId, printerId });
}

export async function uploadPrinterDiagnostic(request: Request, env: Env, repositoryId: string) {
  const auth = await requireSyncToken(request, env, repositoryId, "repo:write");
  if (auth.response) return auth.response;
  if (!auth.printerId) {
    return json({ error: "A printer-bound sync token is required" }, { status: 403 });
  }
  const principal = { tokenId: auth.tokenId, userId: auth.userId, repositoryId, printerId: auth.printerId };

  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = Number(contentLengthHeader);
  if (!contentLengthHeader || !Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return json({ error: "Diagnostic upload requires a valid Content-Length" }, { status: 411 });
  }
  if (contentLength > maxDiagnosticUploadBytes) {
    return json({ error: "Diagnostic upload exceeds the 16 MiB limit" }, { status: 413 });
  }

  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!["application/gzip", "application/octet-stream", "application/zip", "text/plain"].includes(contentType)) {
    return json({ error: "Diagnostic upload must be plain text, gzip, or a Klippee ZIP bundle" }, { status: 415 });
  }

  // One printer shares a budget across all of its sync tokens. Hashing fixes
  // the binding key length and avoids exposing historical identifiers.
  const ownerPrinterHash = await sha256Hex(`${auth.userId}\0${auth.printerId}`);
  const limited = await enforcePrincipalRateLimit(
    env.DIAGNOSTIC_UPLOAD_RATE_LIMITER,
    `diagnostic-upload:${ownerPrinterHash}`,
    {
      error: "Too many diagnostic uploads for this printer. Retry after 60 seconds.",
      resource: "printer-diagnostic-uploads",
    },
  );
  if (limited) return limited;

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) {
    return json({ error: "Diagnostic upload is empty" }, { status: 400 });
  }
  if (bytes.byteLength > maxDiagnosticUploadBytes) {
    return json({ error: "Diagnostic upload exceeds the 16 MiB limit" }, { status: 413 });
  }

  const fileName = safeFileName(request.headers.get("x-klippee-log-name"));
  if ((contentType === "application/gzip" || fileName.endsWith(".gz")) && !isGzipBytes(bytes)) {
    return json({ error: "Diagnostic upload is not valid gzip data" }, { status: 400 });
  }
  if ((contentType === "application/zip" || fileName.endsWith(".zip")) && !isZipBytes(bytes)) {
    return json({ error: "Diagnostic upload is not valid ZIP data" }, { status: 400 });
  }

  const timestamp = nowIso();
  const expiresAt = futureIso(diagnosticUploadTtlSeconds);
  const reservationExpiresAt = futureIso(uploadReservationTtlSeconds);
  const id = crypto.randomUUID();
  const key = `diagnostics/${ownerPrinterHash}/${id}/${fileName}`;
  const originalSizeHeader = Number(request.headers.get("x-klippee-original-size"));
  const originalSizeBytes = Number.isSafeInteger(originalSizeHeader) && originalSizeHeader >= bytes.byteLength
    ? originalSizeHeader
    : bytes.byteLength;
  const truncated = request.headers.get("x-klippee-truncated") === "1";

  // Clear old failed reservations and legacy over-retention before reserving a
  // bounded D1 row. New R2 objects are never written without a durable row
  // that a later request or scheduled cleanup can retry.
  await removeExpiredDiagnosticUploads(env, auth.userId, auth.printerId);
  await enforceDiagnosticRetention(env, auth.userId, auth.printerId);

  const stored = await DiagnosticUploadRepository.reserve(writeDb(env), principal, {
    id, userId: auth.userId, printerId: auth.printerId, repositoryId, fileName, contentType, originalSizeBytes,
    truncated: truncated ? 1 : 0, r2Key: key, createdAt: timestamp, expiresAt: reservationExpiresAt,
  }, maxDiagnosticUploadRowsPerPrinter);
  if ((stored.meta.changes ?? 0) !== 1) {
    if (!await syncTokenStillOwnsPrinter(
      env,
      auth.tokenId,
      auth.userId,
      repositoryId,
      auth.printerId,
    )) {
      return json({ error: "The printer was removed while the diagnostic was uploading" }, { status: 409 });
    }
    return json(
      { error: "Diagnostic upload retention is busy. Retry shortly." },
      { headers: { "retry-after": "5" }, status: 503 },
    );
  }

  const reservedRow = { id, r2_key: key };
  try {
    await env.BLOBS.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { expiresAt },
    });
  } catch (error) {
    await removeUploadRows(env, diagnosticUploadTable, [reservedRow]);
    throw error;
  }

  const finalized = await DiagnosticUploadRepository.finalize(writeDb(env), principal, id, key, bytes.byteLength, expiresAt);
  if ((finalized.meta.changes ?? 0) !== 1) {
    await removeUploadRows(env, diagnosticUploadTable, [reservedRow]);
    return json({ error: "The printer was removed while the diagnostic was uploading" }, { status: 409 });
  }

  await enforceDiagnosticRetention(env, auth.userId, auth.printerId);

  return json({
    upload: publicUpload({
      content_type: contentType,
      created_at: timestamp,
      expires_at: expiresAt,
      file_name: fileName,
      id,
      original_size_bytes: originalSizeBytes,
      printer_id: auth.printerId,
      r2_key: key,
      repository_id: repositoryId,
      size_bytes: bytes.byteLength,
      truncated: truncated ? 1 : 0,
      user_id: auth.userId,
    }),
    url: `${env.APP_ORIGIN}/log-diagnostics?upload=${encodeURIComponent(id)}`,
  }, { status: 201 });
}

export async function listDiagnosticUploads(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  await removeExpiredDiagnosticUploads(env, user.id).catch(() => undefined);
  const result = await DiagnosticUploadRepository.listForUser(readDb(env), user.id, nowIso());
  return json({ uploads: result.map(publicUpload) });
}

export async function getDiagnosticUpload(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const row = await DiagnosticUploadRepository.getForUser(readDb(env), id, user.id, nowIso());
  if (!row) return json({ error: "Diagnostic upload not found" }, { status: 404 });
  const object = await env.BLOBS.get(row.r2_key);
  if (!object) return json({ error: "Diagnostic upload data is unavailable" }, { status: 404 });
  return new Response(object.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${row.file_name.replace(/"/g, "_")}"`,
      "content-length": String(row.size_bytes),
      "content-type": row.content_type,
      ...securityHeaders(),
    },
  });
}

export async function deleteDiagnosticUpload(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const row = await DiagnosticUploadRepository.getObjectForOwner(writeDb(env), id, user.id);
  if (!row) return json({ error: "Diagnostic upload not found" }, { status: 404 });
  await removeUploadRows(env, diagnosticUploadTable, [row]);
  return json({ ok: true });
}
