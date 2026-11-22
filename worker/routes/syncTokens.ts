import { readDb, writeDb } from "../db";
import { json, readJsonBody } from "../http";
import { PrinterRepository } from "../repositories/PrinterRepository";
import { SyncTokenRepository } from "../repositories/SyncTokenRepository";
import {
  maxSyncTokenNameBytes,
  maxSyncTokensPerRepository,
  storageQuotaExceeded,
} from "../storageLimits";
import type { Env, SyncTokenRow } from "../types";
import { hashToken, nowIso, randomToken } from "../util";
import { requireUser } from "./auth";
import { ensureRepositoryOwner } from "./repositories";

export function publicSyncToken(row: SyncTokenRow) {
  return {
    created_at: row.created_at,
    expires_at: row.expires_at,
    id: row.id,
    last_used_at: row.last_used_at,
    name: row.name,
    printer_id: row.printer_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    token_prefix: row.token_prefix,
  };
}

export async function listSyncTokens(request: Request, env: Env, repositoryId: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const db = readDb(env);
  const repo = await ensureRepositoryOwner(db, user.id, repositoryId);
  if (!repo) {
    return json({ error: "Repository not found" }, { status: 404 });
  }

  const result = await SyncTokenRepository.listForRepository(db, user.id, repositoryId);

  return json({ tokens: result.map(publicSyncToken) });
}

export async function createSyncToken(request: Request, env: Env, repositoryId: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const db = writeDb(env);
  const repo = await ensureRepositoryOwner(db, user.id, repositoryId);
  if (!repo) {
    return json({ error: "Repository not found" }, { status: 404 });
  }

  const usage = await SyncTokenRepository.countForRepository(db, user.id, repositoryId);
  if ((usage?.count ?? 0) >= maxSyncTokensPerRepository) {
    return storageQuotaExceeded("sync-tokens", maxSyncTokensPerRepository);
  }

  const parsedBody = await readJsonBody<{
    clientMode?: string;
    name?: string;
    printerId?: string;
    scopes?: string[];
  } | null>(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;
  if (body?.name !== undefined && typeof body.name !== "string") {
    return json({ error: "Sync token name must be a string" }, { status: 400 });
  }
  const tokenName = body?.name?.trim() || "Printer sync token";
  if (new TextEncoder().encode(tokenName).byteLength > maxSyncTokenNameBytes) {
    return json({
      error: `Sync token name must be at most ${maxSyncTokenNameBytes} UTF-8 bytes`,
    }, { status: 400 });
  }
  const printerId = typeof body?.printerId === "string" && body.printerId ? body.printerId : null;
  if (printerId) {
    const printer = await PrinterRepository.getSyncTokenBinding(db, printerId, user.id);
    if (!printer || (printer.repository_id && printer.repository_id !== repositoryId)) {
      return json({ error: "Printer not found for this repository" }, { status: 404 });
    }
    if (!printer.repository_id) {
      await PrinterRepository.bindRepository(db, printerId, user.id, repositoryId, nowIso());
    }
  }
  const scopes = Array.from(new Set(body?.scopes?.filter((scope) => ["repo:read", "repo:write"].includes(scope)) ?? [
    "repo:read",
    "repo:write",
  ]));
  if (body?.clientMode === "desktop") {
    scopes.push("client:desktop");
  }
  const token = `klp_${randomToken(36)}`;
  const tokenHash = await hashToken(token, env.SESSION_SECRET);
  const tokenPrefix = token.slice(0, 12);
  const timestamp = nowIso();
  const row = {
    created_at: timestamp,
    expires_at: null,
    id: crypto.randomUUID(),
    last_used_at: null,
    name: tokenName,
    printer_id: printerId,
    scopes_json: JSON.stringify(scopes),
    token_prefix: tokenPrefix,
  };

  const stored = await SyncTokenRepository.create(db, { id: row.id, userId: user.id, repositoryId,
    printerId: row.printer_id, name: row.name, tokenHash, tokenPrefix: row.token_prefix,
    scopesJson: row.scopes_json, lastUsedAt: row.last_used_at, expiresAt: row.expires_at, createdAt: row.created_at,
  }, maxSyncTokensPerRepository);
  if ((stored.meta.changes ?? 0) !== 1) {
    return storageQuotaExceeded("sync-tokens", maxSyncTokensPerRepository);
  }

  return json({ token, tokenRecord: publicSyncToken(row) }, { status: 201 });
}

export async function deleteSyncToken(request: Request, env: Env, repositoryId: string, tokenId: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const db = writeDb(env);
  const repo = await ensureRepositoryOwner(db, user.id, repositoryId);
  if (!repo) {
    return json({ error: "Repository not found" }, { status: 404 });
  }

  await SyncTokenRepository.remove(db, tokenId, repositoryId, user.id);

  return json({ ok: true });
}
