import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bootSharedWorker, db, dispatch, disposeSharedWorker, publishStoredPackage,
  SESSION_TOKEN, SECOND_SESSION_TOKEN } from "./helpers.mjs";

const owner = { cookie: `__Host-klippee_session=${SESSION_TOKEN}` };
const other = { cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };

describe("Public detail and publication-state reads", () => {
  let slug, snapshotFiles;
  async function get(path, headers) {
    const response = await dispatch(path, { headers });
    assert.equal(response.status, 200);
    return response.json();
  }
  before(async () => {
    await bootSharedWorker();
    slug = (await publishStoredPackage()).slug;
    snapshotFiles = (await get(`/api/packages/${slug}`)).package.files;
    const row = await db.prepare("SELECT id, package_json FROM public_packages WHERE slug = ?").bind(slug).first();
    const pkg = { ...JSON.parse(row.package_json), companionAssetIds: ["shared-source", "missing", "shared-source"] };
    await db.batch([
      db.prepare(`INSERT INTO repository_versions (id,repository_id,version_number,previous_version_id,message,source,files_json,created_at)
        VALUES ('public-read-version-2','repo_1',2,'version_1','Unapproved','printer-agent','[]','2026-11-01')`),
      db.prepare("UPDATE printers SET applied_version_id = 2 WHERE id = 'printer_1'"),
      db.prepare(`UPDATE public_packages SET name = 'public-read-alias', package_json = ?, repository_id = 'repo_1',
        printer_id = 'printer_1', approved_version_id = 'version_1', auto_update_enabled = 1, auto_update_error = 'Review fixture'
        WHERE id = ?`).bind(JSON.stringify(pkg), row.id),
    ]);
    const asset = { id: "owner-attachment", kind: "filament", title: "Owner asset", description: "Public fixture",
      content: "PUBLIC_PROFILE_BODY", public: true, tags: ["0.4 mm nozzle"], version: "1", createdAt: "2000-01-01", updatedAt: "2000-01-01" };
    async function insert(id, userId, sourceId, title, profileId, configId, value = asset) {
      await db.prepare(`INSERT INTO public_companion_assets
        (id,user_id,source_asset_id,slug,kind,title,asset_json,created_at,updated_at,published_at,orca_profile_id,printer_config_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, userId, sourceId, id, "filament", title,
        JSON.stringify(value), "2000-01-01", "2000-01-01", "2000-01-01", profileId, configId).run();
    }
    await insert("owner-public-asset", "user_1", "shared-source", "AAA Legacy", null, row.id);
    await insert("foreign-public-asset", "user_2", "shared-source", "AAA Foreign", "foreign-profile", row.id,
      { ...asset, id: "foreign-attachment" });
    for (let index = 0; index < 65; index += 1) {
      const id = `detail-profile-${String(index).padStart(2, "0")}`;
      await insert(id, "user_1", id, `Profile ${String(index).padStart(2, "0")}`, id, row.id);
    }
    await insert("unlinked-public-asset", "user_1", "unlinked-source", "Unlinked", null, null);
    await insert("broken-public-asset", "user_1", "broken-source", "Broken", null, null, {});
  });
  after(disposeSharedWorker);

  it("resolves slug/name aliases to the approved snapshot and owner-scoped, deduplicated attachments", async () => {
    for (const id of [slug, "public-read-alias"]) {
      const { package: pkg } = await get(`/api/packages/${id}`);
      assert.equal(pkg.id, slug);
      assert.equal(pkg.tracksAppliedConfiguration, true);
      assert.deepEqual(pkg.files, snapshotFiles);
      assert.deepEqual(pkg.companionAssets.map(asset => asset.id), ["owner-attachment"]);
      assert.equal(pkg.companionAssets[0].printerConfig, null);
    }
    assert.equal((await dispatch("/api/packages/missing-public-package")).status, 404);
  });

  it("keeps approved/current state distinct and scopes status reads to the owner", async () => {
    for (const id of [slug, "package_1"]) {
      assert.deepEqual((await get(`/api/public-packages/${id}/status`, owner)).status, {
        approvedVersionId: "version_1", autoUpdateEnabled: true, autoUpdateError: "Review fixture",
        currentAppliedVersionId: "public-read-version-2", hasUnpublishedAppliedVersion: true, linked: true,
      });
      assert.equal((await dispatch(`/api/public-packages/${id}/status`, { headers: other })).status, 404);
    }
    await db.prepare("UPDATE printers SET applied_version_id = 99 WHERE id = 'printer_1'").run();
    const status = (await get(`/api/public-packages/${slug}/status`, owner)).status;
    assert.equal(status.currentAppliedVersionId, null);
    assert.equal(status.hasUnpublishedAppliedVersion, false);
  });

  it("joins asset context only to the same publisher and preserves absent/malformed responses", async () => {
    const owned = (await get("/api/public-companion-assets/owner-public-asset")).asset;
    assert.equal(owned.printerConfig.slug, slug);
    assert.equal((await get("/api/public-companion-assets/foreign-public-asset")).asset.printerConfig, null);
    assert.equal((await get("/api/public-companion-assets/unlinked-public-asset")).asset.printerConfig, null);
    for (const id of ["missing-public-asset", "broken-public-asset"]) {
      assert.equal((await dispatch(`/api/public-companion-assets/${id}`)).status, 404);
    }
  });

  it("keeps linked Orca summaries owner-matched, ordered, bounded and available by name alias", async () => {
    for (const id of [slug, "public-read-alias"]) {
      const { assets } = await get(`/api/public-packages/${id}/orca-profiles`);
      assert.equal(assets.length, 64);
      assert.deepEqual(assets.map(asset => asset.title), Array.from({ length: 64 }, (_, i) => `Profile ${String(i).padStart(2, "0")}`));
      assert(assets.every(asset => !Object.hasOwn(asset, "content") && !Object.hasOwn(asset, "user_id")));
      assert.deepEqual(assets[0].tags, ["0.4 mm nozzle"]);
    }
    assert.deepEqual(await get("/api/public-packages/missing-public-package/orca-profiles"), { assets: [] });
  });
});
