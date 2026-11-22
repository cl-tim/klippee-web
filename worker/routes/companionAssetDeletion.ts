import { writeDb } from "../db";
import { json, readJsonBody } from "../http";
import { CompanionAssetRepository } from "../repositories/CompanionAssetRepository";
import { withUser } from "../route";

export const deleteCompanionAsset = withUser(async (request, env, user, params) => {
  const db = writeDb(env);
  const existing = await CompanionAssetRepository.getDeleteContext(db, user.id, params.id);
  if (!existing) return json({ code: "companion_asset_not_found", error: "Companion asset not found" }, { status: 404 });
  const body = await readJsonBody<{ updatedAt?: unknown } | null>(request, 4_096);
  if (!body.ok) return body.response;
  if (typeof body.value?.updatedAt !== "string" || !body.value.updatedAt) {
    return json({ error: "Deletion requires the preset's updatedAt" }, { status: 400 });
  }
  const removed = await CompanionAssetRepository.deleteUnused(db, user.id, params.id, {
    updatedAt: body.value.updatedAt, assetJson: existing.asset_json,
  });
  if (!removed.length) {
    if (!await CompanionAssetRepository.getDeleteContext(db, user.id, params.id)) {
      return json({ code: "companion_asset_not_found", error: "Companion asset not found" }, { status: 404 });
    }
    return json({ code: "companion_asset_delete_conflict",
      error: "This preset changed or is attached to a private configuration package. Reload it and remove any package attachments before deleting.",
    }, { status: 409 });
  }
  // Public snapshots, their configuration links and independent copies remain.
  // The private preset is inline D1 data; no printer or R2 operation is needed.
  return json({ ok: true, deletedAssetId: params.id });
});
