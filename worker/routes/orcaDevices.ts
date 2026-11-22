import { writeDb } from "../db";
import { json, parseBearerToken, readJsonBody } from "../http";
import { enforceRateLimit } from "../rateLimit";
import { OrcaCaptureRepository } from "../repositories/OrcaCaptureRepository";
import { OrcaDeviceRepository } from "../repositories/OrcaDeviceRepository";
import type { Env } from "../types";
import { futureIso, hashToken, isRecord, nowIso } from "../util";
import { requireUser } from "./auth";
import { captureGrant } from "./orcaSetups";

const deviceToken = /^klorcadevice_[A-Za-z0-9_-]{43}$/;

// The plugin creates and persists its secret before pairing. Retrying a lost
// response is safe; another secret cannot claim an already-paired code.
export async function pairOrcaDevice(request: Request, env: Env) {
  const grant = await captureGrant(request, env);
  if (!grant || grant.scope !== "pair") return json({ error: "Create a new Connect Orca code in Klippee." }, { status: 401 });
  const body = await readJsonBody(request, 4096);
  if (!body.ok) return body.response;
  if (!isRecord(body.value) || typeof body.value.token !== "string" || !deviceToken.test(body.value.token)) return json({ error: "Invalid Orca connection" }, { status: 400 });
  const db = writeDb(env), tokenHash = await hashToken(body.value.token, env.SESSION_SECRET), now = nowIso();
  await OrcaDeviceRepository.pair(db, { id: grant.id, userId: grant.user_id, tokenHash,
    grantHash: await hashToken(parseBearerToken(request)!, env.SESSION_SECRET), timestamp: now });
  const paired = await OrcaDeviceRepository.getPaired(db, grant.id, grant.user_id, tokenHash);
  return paired ? json({ connected: true }) : json({ error: "Code already used or ten Orca connections are saved. Disconnect an old connection in Klippee." }, { status: 409 });
}

export async function orcaDevice(request: Request, env: Env) {
  const token = parseBearerToken(request);
  if (!token || !deviceToken.test(token)) return null;
  const db = writeDb(env);
  const device = await OrcaDeviceRepository.getAuthenticationContext(db, await hashToken(token, env.SESSION_SECRET));
  if (device) await OrcaDeviceRepository.recordActivity(db, device.id, nowIso());
  return device;
}

export async function listOrcaDevices(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const rows = await OrcaDeviceRepository.listForUser(writeDb(env), user.id);
  return json({ devices: rows.map((device) => ({ ...device, uploadsEnabled: !!device.uploadsEnabled })) });
}

export async function setOrcaDeviceUploads(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const body = await readJsonBody(request, 4096);
  if (!body.ok) return body.response;
  if (!isRecord(body.value) || typeof body.value.uploadsEnabled !== "boolean") return json({ error: "Choose whether to allow imports and setup saves" }, { status: 400 });
  const db = writeDb(env);
  // Permission changes and invalidation of reviewed uploads remain atomic.
  const results = await OrcaDeviceRepository.setUploads(db, user.id, id, body.value.uploadsEnabled);
  return results[0].meta.changes ? json({ ok: true }) : json({ error: "Orca installation not found" }, { status: 404 });
}

export async function createOrcaDeviceUpload(request: Request, env: Env) {
  const device = await orcaDevice(request, env);
  if (!device) return json({ error: "Connect this Orca installation again in Klippee." }, { status: 401 });
  if (!device.uploads_enabled) return json({ error: "Enable Allow profile imports and setup saves for this installation in Klippee, then review again." }, { status: 403 });
  const limited = await enforceRateLimit(env.AUTH_RATE_LIMITER, request, "orca-upload-reviews", "Too many upload reviews. Try again shortly.");
  if (limited) return limited;
  const body = await readJsonBody(request, 4096);
  if (!body.ok) return body.response;
  const value = body.value;
  if (!isRecord(value) || typeof value.scope !== "string" || !["library", "setup"].includes(value.scope) || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)
    || typeof value.token !== "string" || !/^klorca_[A-Za-z0-9_-]{43}$/.test(value.token)) return json({ error: "Invalid upload review" }, { status: 400 });
  const db = writeDb(env), now = nowIso(), expiresAt = futureIso(600), tokenHash = await hashToken(value.token, env.SESSION_SECRET);
  await OrcaCaptureRepository.pruneExpired(db, device.user_id, now);
  await OrcaDeviceRepository.createUpload(db, { id: value.id, userId: device.user_id, deviceId: device.id,
    deviceHash: await hashToken(parseBearerToken(request)!, env.SESSION_SECRET), tokenHash, scope: value.scope, expiresAt });
  const grant = await OrcaCaptureRepository.getReviewedUpload(db, value.id, device.user_id, tokenHash, value.scope, device.id);
  return grant ? json({ scope: value.scope, expiresAt: grant.expires_at, printerName: value.scope === "library" ? "your profile library" : "your saved setups" })
    : json({ error: "Upload permission changed or too many reviews are open. Review again after cancelling old codes or waiting ten minutes." }, { status: 409 });
}

export async function revokeOrcaDevice(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  // Revoking also invalidates the remaining pairing code, preventing re-pair.
  const db = writeDb(env);
  await OrcaDeviceRepository.revoke(db, id, user.id);
  return json({ ok: true });
}

export async function disconnectOrcaDevice(request: Request, env: Env) {
  const device = await orcaDevice(request, env);
  if (!device) return json({ error: "This Orca connection has been disconnected. Connect again in Klippee." }, { status: 401 });
  const db = writeDb(env);
  await OrcaDeviceRepository.revoke(db, device.id);
  return json({ ok: true });
}
