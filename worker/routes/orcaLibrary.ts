import { parseOrcaLibrary, type OrcaLibrarySummary } from "../../src/features/orca/orcaCapture";
import { writeDb } from "../db";
import { json, parseBearerToken, readJsonBody } from "../http";
import type { Env } from "../types";
import { hashToken, isRecord, nowIso } from "../util";
import { requireUser } from "./auth";
import { captureGrant } from "./orcaSetups";
import { orcaDevice } from "./orcaDevices";
import { tagOrcaProfiles } from "../../src/features/orca/orcaProfileTags";
import { OrcaLibraryRepository } from "../repositories/OrcaLibraryRepository";
import { PrinterRepository } from "../repositories/PrinterRepository";
import { orcaPublicationId } from "../orcaPublication";
import { tryUpdateAutomaticOrcaPublications } from "../orcaPublicationUpdates";

export async function saveOrcaLibrary(request: Request, env: Env) {
  const grant = await captureGrant(request, env);
  if (!grant || grant.scope !== "library") return json({ error: "Create a profile import code in Klippee." }, { status: 401 });
  const db = writeDb(env);
  const receipt = await OrcaLibraryRepository.getImportReceipt(db, grant.id, grant.user_id);
  if (receipt) {
    await tryUpdateAutomaticOrcaPublications(env, grant.user_id, grant.id);
    return json({ library: JSON.parse(receipt.summary_json) });
  }
  const body = await readJsonBody(request, 8_000_000, "Profile library is too large (maximum 8 MB)");
  if (!body.ok) return body.response;
  if (!isRecord(body.value) || typeof body.value.hostVersion !== "string" || body.value.hostVersion.length > 80) return json({ error: "Missing OrcaSlicer version" }, { status: 400 });
  let parsed: ReturnType<typeof parseOrcaLibrary>;
  try { parsed = parseOrcaLibrary(body.value.library); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid profile library" }, { status: 400 }); }
  const { library } = parsed;
  const currentJson = JSON.stringify(library.current);
  if (new TextEncoder().encode(currentJson).byteLength > 512_000) return json({ error: "Current setup exceeds 512 KB" }, { status: 413 });
  const updatedAt = nowIso();
  const summary: OrcaLibrarySummary = { id: grant.id, updatedAt, hostVersion: body.value.hostVersion,
    profiles: library.profiles.map((profile) => {
      const node = library.nodes[profile.node];
      return { id: profile.node, name: node.name, kind: node.kind, custom: profile.custom, enabled: profile.enabled,
        parent: node.parent ? library.nodes[node.parent].name : null, nozzle: node.saved.nozzle_diameter ?? "", printerIds: [] };
    }) };
  // Each preset is a separate row: large libraries cannot exceed D1's row limit.
  // A single transactional batch checks the still-valid grant on every write.
  // The receipt is inserted last, preventing retries (including old codes) from
  // overwriting a later import. No partial library is visible to readers.
  const receiptSummary = { id: grant.id, updatedAt, profiles: summary.profiles.length };
  const nodes: Array<{ id: string; json: string }> = [];
  for (const [id, node] of Object.entries(library.nodes)) {
    const encoded = JSON.stringify(node);
    if (new TextEncoder().encode(encoded).byteLength > 512_000) return json({ error: "An individual profile exceeds 512 KB" }, { status: 413 });
    nodes.push({ id, json: encoded });
  }
  const results = await OrcaLibraryRepository.saveImport(db, {
    id: grant.id, userId: grant.user_id, tokenHash: await hashToken(parseBearerToken(request)!, env.SESSION_SECRET),
    timestamp: updatedAt, summaryJson: JSON.stringify(summary), currentJson, receiptJson: JSON.stringify(receiptSummary), nodes,
  });
  if (!results.at(-1)?.meta.changes) {
    const raced = await OrcaLibraryRepository.getImportReceipt(db, grant.id, grant.user_id);
    if (raced) { await tryUpdateAutomaticOrcaPublications(env, grant.user_id, grant.id); return json({ library: JSON.parse(raced.summary_json) }); }
    return json({ error: "Import code expired or was cancelled. Create another code." }, { status: 409 });
  }
  await tryUpdateAutomaticOrcaPublications(env, grant.user_id, grant.id);
  return json({ library: receiptSummary }, { status: 201 });
}

export async function getOrcaLibrary(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const db = writeDb(env);
  // Read summary, metadata and links together so a concurrent import cannot
  // combine profiles from one library revision with settings from another.
  const [summaries, metadata, printerLinks, publications] = await OrcaLibraryRepository.getView(db, user.id);
  const row = summaries[0];
  if (!row) return json({ library: null });
  const library: OrcaLibrarySummary = JSON.parse(row.summary_json);
  library.profiles = tagOrcaProfiles(library.profiles, metadata);
  for (const profile of library.profiles) profile.printerIds = printerLinks.filter((link) => link.profile_id === profile.id).map((link) => link.printer_id);
  const published = new Map(publications.map(row => [row.source_asset_id, row]));
  if (published.size) await Promise.all(library.profiles.map(async profile => {
    const publication = published.get(await orcaPublicationId(user.id, profile.id));
    if (publication) {
      profile.publicUrl = `${env.APP_ORIGIN}/assets/${publication.slug}`;
      profile.autoUpdateEnabled = publication.auto_update_enabled === 1;
      profile.autoUpdateError = publication.auto_update_error;
      profile.printerConfig = publication.printer_config_slug && publication.printer_config_title
        ? { slug: publication.printer_config_slug, title: publication.printer_config_title } : null;
    }
  }));
  return json({ library });
}

export async function linkOrcaProfile(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const body = await readJsonBody(request, 4096);
  if (!body.ok) return body.response;
  if (!isRecord(body.value) || typeof body.value.profileId !== "string" || typeof body.value.printerId !== "string" || typeof body.value.linked !== "boolean") return json({ error: "Choose a profile and printer" }, { status: 400 });
  const { profileId } = body.value;
  const db = writeDb(env);
  const row = await OrcaLibraryRepository.getSummary(db, user.id);
  const library: OrcaLibrarySummary | null = row ? JSON.parse(row.summary_json) : null;
  if (!library?.profiles.some((item) => item.id === profileId && item.kind === "machine")) return json({ error: "Printer profile not found" }, { status: 404 });
  const printer = await PrinterRepository.getOwnedId(db, body.value.printerId, user.id);
  if (!printer) return json({ error: "Physical printer not found" }, { status: 404 });
  await OrcaLibraryRepository.linkPrinter(db, user.id, body.value.profileId, body.value.printerId, body.value.linked);
  return json({ ok: true });
}

export async function exportOrcaLibrary(request: Request, env: Env, individual = false) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  return exportLibraryForOwner(request, env, user.id, individual);
}

async function exportLibraryForOwner(request: Request, env: Env, userId: string, individual: boolean, expectedImport?: string) {
  const db = writeDb(env);
  const rows = await OrcaLibraryRepository.getExportSnapshot(db, userId);
  const row = rows[0][0];
  if (!row) return json({ error: "Import your Orca profiles first" }, { status: 404 });
  const summary: OrcaLibrarySummary = JSON.parse(row.summary_json);
  if (expectedImport && summary.id !== expectedImport) return json({ error: "Your library changed. Reload the library in Orca and choose the profile again." }, { status: 409 });
  if (individual) {
    const id = new URL(request.url).searchParams.get("profileId");
    if (!id || !summary.profiles.some((profile) => profile.id === id)) return json({ error: "Library profile not found" }, { status: 404 });
    const all = Object.fromEntries(rows[1].map(node => [node.node_id, JSON.parse(node.node_json)]));
    const nodes: typeof all = {};
    let cursor: string | null = id;
    while (cursor) {
      if (!all[cursor] || nodes[cursor]) return json({ error: "Profile inheritance is incomplete. Import your library again." }, { status: 409 });
      nodes[cursor] = all[cursor]; cursor = all[cursor].parent;
    }
    const snapshot = { format: "klippee-orca-profile/v1", nodes, selections: [{ node: id, slot: null, dirty: false, effective: { ...nodes[id].saved }, changes: {} }] };
    const filename = nodes[id].name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "profile";
    return json({ snapshot }, { headers: { "content-disposition": `attachment; filename="klippee-orca-${filename}.json"` } });
  }
  return json({ format: "klippee-orca-library/v1", profiles: summary.profiles.map((profile) => ({ node: profile.id, custom: profile.custom, enabled: profile.enabled })),
    nodes: Object.fromEntries(rows[1].map(node => [node.node_id, JSON.parse(node.node_json)])), current: JSON.parse(row.current_json) },
  { headers: { "content-disposition": 'attachment; filename="klippee-orca-library.json"' } });
}


async function restoreAccess(request: Request, env: Env) {
  const device = await orcaDevice(request, env);
  if (device) return { user_id: device.user_id, expires_at: null, uploads_enabled: device.uploads_enabled };
  const grant = await captureGrant(request, env);
  return grant?.scope === "restore" ? { ...grant, uploads_enabled: 0 } : null;
}

export async function browseOrcaLibrary(request: Request, env: Env) {
  const grant = await restoreAccess(request, env);
  if (!grant) return json({ error: "This Orca connection expired or was disconnected. Connect again in Klippee." }, { status: 401 });
  const row = await OrcaLibraryRepository.getSummary(writeDb(env), grant.user_id);
  return json({ library: row ? JSON.parse(row.summary_json) : null, expiresAt: grant.expires_at, uploadsEnabled: !!grant.uploads_enabled });
}

export async function fetchOrcaProfile(request: Request, env: Env) {
  const grant = await restoreAccess(request, env);
  if (!grant) return json({ error: "This Orca connection expired or was disconnected. Connect again in Klippee." }, { status: 401 });
  const body = await readJsonBody(request, 4096);
  if (!body.ok) return body.response;
  if (!isRecord(body.value) || typeof body.value.profileId !== "string" || typeof body.value.importId !== "string" || !body.value.importId) return json({ error: "Choose a library profile" }, { status: 400 });
  const url = new URL(request.url); url.searchParams.set("profileId", body.value.profileId);
  return exportLibraryForOwner(new Request(url, { headers: request.headers }), env, grant.user_id, true, body.value.importId);
}
