import type { OrcaCapture, OrcaLibrarySummary } from "../../src/features/orca/orcaCapture";
import { scanOrcaPublication, type OrcaPublicationReview } from "../../src/features/orca/orcaPublication";
import { companionAssetFromInput, createPublicCompanionAssetPlan, publicCompanionAssetResponse } from "../companionAssets";
import { writeDb } from "../db";
import { json, readJsonBody } from "../http";
import { buildOrcaPublication, orcaPublicationId } from "../orcaPublication";
import { tryUpdateAutomaticOrcaPublications } from "../orcaPublicationUpdates";
import { maxCompanionAssetsPerUser, storageQuotaExceeded } from "../storageLimits";
import type { D1Client, Env } from "../types";
import { OrcaLibraryRepository } from "../repositories/OrcaLibraryRepository";
import { PublicCompanionAssetRepository } from "../repositories/PublicCompanionAssetRepository";
import { PublicPackageRepository } from "../repositories/PublicPackageRepository";
import { OrcaPublicationRepository } from "../repositories/OrcaPublicationRepository";
import { isRecord, nowIso } from "../util";
import { requireUser } from "./auth";

async function loadCandidate(env: Env, userId: string, profileId: string) {
  const id = await orcaPublicationId(userId, profileId), db = writeDb(env);
  const [libraries, presets, publications, printerConfigs] = await OrcaLibraryRepository.getPublicationCandidate(db, userId, id);
  const row = libraries[0];
  if (!row) return { response: json({ error: "Import your Orca profiles first." }, { status: 404 }) };
  const summary: OrcaLibrarySummary = JSON.parse(row.summary_json);
  const all: OrcaCapture["nodes"] = Object.fromEntries(presets.map(node => [node.node_id, JSON.parse(node.node_json)]));
  const built = await buildOrcaPublication(summary, all, profileId);
  if (!built.candidate) return { response: json({ error: built.error }, { status: built.status }) };
  const existing = publications[0];
  const published = existing ? publicCompanionAssetResponse(env.APP_ORIGIN, existing) : null;
  const linked = printerConfigs.find(config => config.id === existing?.printer_config_id);
  const review: OrcaPublicationReview = { ...built.candidate, importId: summary.id,
    title: published?.title ?? built.candidate.title, description: published?.description ?? "", publicUrl: published?.publicUrl ?? null,
    autoUpdateEnabled: existing?.auto_update_enabled === 1, autoUpdateError: existing?.auto_update_error ?? null,
    printerConfig: linked ? { slug: linked.slug, title: linked.title } : null,
    printerConfigs: printerConfigs.map(({ slug, title }) => ({ slug, title })) };
  return { review, existing, id };
}

async function resolvePrinterConfig(db: D1Client, userId: string, slug: unknown, existingId?: string | null) {
  if (slug !== undefined && slug !== null && (typeof slug !== "string" || !slug || slug.length > 256)) {
    return { response: json({ error: "Choose a published printer configuration." }, { status: 400 }) };
  }
  if (slug === null || (slug === undefined && !existingId)) return { config: null };
  const config = await PublicPackageRepository.getOwnedConfig(db, userId, typeof slug === "string" ? slug : existingId!, slug !== undefined);
  return config ? { config } : { response: json({ error: "Choose one of your published printer configurations." }, { status: 404 }) };
}

export async function reviewOrcaPublication(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const profileId = new URL(request.url).searchParams.get("profileId");
  if (!profileId || profileId.length > 1024) return json({ error: "Choose a library profile." }, { status: 400 });
  const candidate = await loadCandidate(env, user.id, profileId);
  return candidate.response ?? json({ review: candidate.review });
}

export async function publishOrcaProfile(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const body = await readJsonBody(request, 16_000);
  if (!body.ok) return body.response;
  const input = body.value;
  if (!isRecord(input) || typeof input.profileId !== "string" || input.profileId.length > 1024
    || typeof input.title !== "string" || !input.title.trim() || input.title.length > 160
    || typeof input.description !== "string" || input.description.length > 4000) return json({ error: "Provide a profile, title (up to 160 characters) and description (up to 4000 characters)." }, { status: 400 });
  const candidate = await loadCandidate(env, user.id, input.profileId);
  if (candidate.response) return candidate.response;
  const { review, existing, id } = candidate;
  if (input.autoUpdateEnabled !== undefined && typeof input.autoUpdateEnabled !== "boolean") return json({ error: "Automatic updates require a boolean." }, { status: 400 });
  const configResult = await resolvePrinterConfig(writeDb(env), user.id, input.printerConfigSlug, existing?.printer_config_id);
  if (configResult.response) return configResult.response;
  const config = configResult.config;
  const enabled = input.autoUpdateEnabled ?? existing?.auto_update_enabled === 1;
  if (input.importId !== review.importId || input.candidateHash !== review.candidateHash) return json({ error: "Your library changed. Close this review and open it again before publishing." }, { status: 409 });
  const findings = [...review.findings, ...scanOrcaPublication({ title: input.title, description: input.description })];
  if (findings.some(finding => finding.severity === "block")) return json({ error: "Remove credentials from the listing, or correct the profile in OrcaSlicer and import it again before publishing.", findings }, { status: 422 });
  if (input.confirmPublic !== true) return json({ error: "Confirm that this profile and its ancestors can be made public." }, { status: 400 });
  if (findings.length && input.acknowledgeSafetyWarnings !== true) return json({ error: "Review and acknowledge the publication warnings.", findings }, { status: 422 });
  const timestamp = nowIso();
  const asset = companionAssetFromInput({ content: review.content, kind: review.kind, title: input.title, description: input.description, tags: review.tags }, id, existing?.created_at ?? timestamp);
  asset.version = String(existing ? Number(JSON.parse(existing.asset_json).version || 0) + 1 : 1);
  const plan = createPublicCompanionAssetPlan({ asset, origin: env.APP_ORIGIN, rowId: crypto.randomUUID(), timestamp, userId: user.id });
  const db = writeDb(env);
  // An import can race the review. Check its revision again in the atomic write;
  // preserve the slug on conflict so title changes never break shared links.
  const stored = await OrcaPublicationRepository.publish(db, {
    row: { id: plan.row.id, userId: user.id, sourceAssetId: id, slug: plan.row.slug, kind: plan.row.kind,
      title: plan.row.title, assetJson: plan.row.asset_json, createdAt: asset.createdAt, updatedAt: timestamp, publishedAt: timestamp,
      orcaProfileId: input.profileId, autoUpdateEnabled: enabled ? 1 : 0, autoUpdateError: null,
      autoUpdateImportId: review.importId, printerConfigId: config?.id ?? null },
    importId: review.importId, previous: existing, limit: maxCompanionAssetsPerUser,
  });
  if (!stored.meta.changes) {
    const current = await OrcaLibraryRepository.getCurrentImport(db, user.id);
    const raced = await PublicCompanionAssetRepository.getOwnedRecord(db, user.id, id);
    if (current?.import_id !== review.importId || existing || raced) return json({ error: "The library or listing changed. Close this review and open it again." }, { status: 409 });
    return storageQuotaExceeded("companion-assets", maxCompanionAssetsPerUser);
  }
  return json({ asset: publicCompanionAssetResponse(env.APP_ORIGIN, { ...plan.row, slug: existing?.slug ?? plan.row.slug,
    printer_config_slug: config?.slug, printer_config_title: config?.title }) }, { status: existing ? 200 : 201 });
}

export async function updateOrcaPublicationSettings(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const body = await readJsonBody(request, 4096);
  if (!body.ok) return body.response;
  const input = body.value;
  if (!isRecord(input) || typeof input.profileId !== "string" || !input.profileId || input.profileId.length > 1024
    || (input.autoUpdateEnabled !== undefined && typeof input.autoUpdateEnabled !== "boolean")
    || (input.autoUpdateEnabled === undefined && input.printerConfigSlug === undefined)) return json({ error: "Choose a profile and its publication settings." }, { status: 400 });
  const db = writeDb(env), id = await orcaPublicationId(user.id, input.profileId);
  const previous = await PublicCompanionAssetRepository.getOwnedRecord(db, user.id, id);
  if (!previous) return json({ error: "Publish this profile before changing its update settings." }, { status: 404 });
  const enabled = input.autoUpdateEnabled ?? previous.auto_update_enabled === 1;
  if (enabled) {
    const candidate = await loadCandidate(env, user.id, input.profileId);
    if (candidate.response) return candidate.response;
  }
  const configResult = await resolvePrinterConfig(db, user.id, input.printerConfigSlug, previous.printer_config_id);
  if (configResult.response) return configResult.response;
  const config = configResult.config;
  const changed = await OrcaPublicationRepository.updateSettings(db, user.id, previous, {
    profileId: input.profileId, enabled, configId: config?.id ?? null, timestamp: nowIso(),
  });
  if (!changed.meta.changes) return json({ error: "The listing changed. Close this review and open it again." }, { status: 409 });
  if (enabled) await tryUpdateAutomaticOrcaPublications(env, user.id, undefined, id);
  const status = await PublicCompanionAssetRepository.getAutomaticStatus(db, user.id, previous.id);
  return json({ publication: { autoUpdateEnabled: status?.auto_update_enabled === 1, autoUpdateError: status?.auto_update_error ?? null,
    printerConfig: config ? { slug: config.slug, title: config.title } : null } });
}

export async function unpublishOrcaProfile(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) return response;
  const profileId = new URL(request.url).searchParams.get("profileId");
  if (!profileId || profileId.length > 1024) return json({ error: "Choose a library profile." }, { status: 400 });
  await OrcaPublicationRepository.remove(writeDb(env), user.id, await orcaPublicationId(user.id, profileId));
  return json({ ok: true });
}
