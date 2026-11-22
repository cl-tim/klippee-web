import { captureSelections, isOmittedCaptureKey, parseOrcaCapture, type OrcaSetupSummary } from "../../src/features/orca/orcaCapture";
import { writeDb } from "../db";
import { json, parseBearerToken, readJsonBody } from "../http";
import { enforceRateLimit } from "../rateLimit";
import { OrcaCaptureRepository } from "../repositories/OrcaCaptureRepository";
import { OrcaSetupRepository } from "../repositories/OrcaSetupRepository";
import { PrinterRepository } from "../repositories/PrinterRepository";
import type { Env } from "../types";
import { futureIso, hashToken, isRecord, nowIso, randomToken } from "../util";
import { requireUser } from "./auth";

const maxSetups = 20;
const maxCaptureBytes = 512_000;
type Grant = { id: string; user_id: string; printer_id: string | null; name: string | null; expires_at: string; scope: string };

export async function createOrcaGrant(request: Request, env: Env, printerId: string | null, scope = "setup") {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const db = writeDb(env);
  if (printerId) {
    const printer = await PrinterRepository.getOwnedId(db, printerId, user.id);
    if (!printer) return json({ error: "Printer not found" }, { status: 404 });
  }
  const limited = await enforceRateLimit(env.AUTH_RATE_LIMITER, request, "orca-grants", "Too many connection codes. Try again shortly.");
  if (limited) return limited;
  await OrcaCaptureRepository.pruneExpired(db, user.id, nowIso());
  const id = crypto.randomUUID();
  const token = `klorca_${randomToken()}`;
  const expiresAt = futureIso(600);
  const inserted = await OrcaCaptureRepository.createGrant(db, {
    id, userId: user.id, printerId, tokenHash: await hashToken(token, env.SESSION_SECRET), expiresAt, scope,
  });
  if (!inserted.meta.changes) return json({ error: "Cancel an existing connection code or wait for it to expire" }, { status: 409 });
  // Embed only the origin: a copied code works with a local or self-hosted instance too.
  return json({ id, code: `${new URL(request.url).origin}/#${token}`, expiresAt }, { status: 201 });
}

export async function revokeOrcaGrant(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const db = writeDb(env);
  await OrcaCaptureRepository.revokeConnection(db, user.id, id);
  return json({ ok: true });
}

export async function captureGrant(request: Request, env: Env): Promise<Grant | null> {
  const token = parseBearerToken(request);
  if (!token || !/^klorca_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return OrcaCaptureRepository.getGrant(writeDb(env), await hashToken(token, env.SESSION_SECRET), nowIso());
}

export async function orcaCaptureContext(request: Request, env: Env) {
  const grant = await captureGrant(request, env);
  return grant ? json({ printerId: grant.printer_id, printerName: grant.name ?? "your profile library", scope: grant.scope, expiresAt: grant.expires_at })
    : json({ error: "Connection code expired or cancelled. Create a new code in Klippee." }, { status: 401 });
}

export async function saveOrcaSetup(request: Request, env: Env) {
  const grant = await captureGrant(request, env);
  if (!grant) return json({ error: "Connection code expired or cancelled. Create a new code in Klippee." }, { status: 401 });
  if (grant.scope !== "setup") return json({ error: "Update the Orca plugin to import your profile library with this code." }, { status: 400 });
  const db = writeDb(env);
  // The grant ID is also the setup ID, making network retries create at most one setup.
  const existing = await OrcaSetupRepository.getSavedSummary(db, grant.id, grant.user_id);
  if (existing) return json({ setup: JSON.parse(existing.summary_json), workspaceUrl: `${new URL(request.url).origin}/slicer` });
  const body = await readJsonBody(request, maxCaptureBytes, "Setup is too large (maximum 512 KB)");
  if (!body.ok) return body.response;
  if (!isRecord(body.value) || typeof body.value.title !== "string" || !body.value.title.trim()
    || body.value.title.length > 120 || typeof body.value.hostVersion !== "string" || body.value.hostVersion.length > 80
    || typeof body.value.hostBuild !== "string" || body.value.hostBuild.length > 80) {
    return json({ error: "Setup needs a title and OrcaSlicer version" }, { status: 400 });
  }
  let parsed: ReturnType<typeof parseOrcaCapture>;
  try { parsed = parseOrcaCapture(body.value.snapshot); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid setup" }, { status: 400 }); }
  const summary: OrcaSetupSummary = {
    id: grant.id, printerId: grant.printer_id, title: body.value.title.trim(), createdAt: nowIso(),
    hostVersion: body.value.hostVersion, hostBuild: body.value.hostBuild,
    nodes: Object.keys(parsed.snapshot.nodes).length, selections: captureSelections(parsed.snapshot),
    omittedKeys: [...new Set([...parsed.omittedKeys, ...(Array.isArray(body.value.omittedKeys) ? body.value.omittedKeys.slice(0, 128).filter(isOmittedCaptureKey) : [])])].sort(),
  };
  const stored = await OrcaSetupRepository.create(db, {
    id: grant.id, userId: grant.user_id, tokenHash: await hashToken(parseBearerToken(request)!, env.SESSION_SECRET),
    summaryJson: JSON.stringify(summary), snapshotJson: JSON.stringify(parsed.snapshot), createdAt: summary.createdAt,
    timestamp: nowIso(), limit: maxSetups,
  });
  if (!stored.meta.changes) {
    const raced = await OrcaSetupRepository.getSavedSummary(db, grant.id, grant.user_id);
    if (raced) return json({ setup: JSON.parse(raced.summary_json), workspaceUrl: `${new URL(request.url).origin}/slicer` });
    return json({ error: "Code expired or storage is full. Remove an old saved setup and create a new code." }, { status: 409 });
  }
  return json({ setup: summary, workspaceUrl: `${new URL(request.url).origin}/slicer` }, { status: 201 });
}

export async function listOrcaSetups(request: Request, env: Env, printerId?: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const rows = await OrcaSetupRepository.listForUser(writeDb(env), user.id, printerId);
  return json({ setups: rows.map((row) => ({ ...JSON.parse(row.summary_json), printerId: row.printer_id })) });
}

export async function getOrcaSetup(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const row = await OrcaSetupRepository.getOwned(writeDb(env), id, user.id);
  return row ? json({ setup: { ...JSON.parse(row.summary_json), printerId: row.printer_id }, snapshot: JSON.parse(row.snapshot_json) }, {
    headers: { "content-disposition": `attachment; filename="klippee-orca-${id.replace(/[^a-zA-Z0-9-]/g, "")}.json"` },
  }) : json({ error: "Setup not found" }, { status: 404 });
}

export async function deleteOrcaSetup(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  // Revoke the original grant too, so deleting a setup cannot enable replay.
  const db = writeDb(env);
  await OrcaSetupRepository.remove(db, id, user.id);
  return json({ ok: true });
}
