import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { bootSharedWorker, disposeSharedWorker, db, dispatch, SESSION_TOKEN, SECOND_SESSION_TOKEN,
  WORKER_ORIGIN, STORAGE_LIMITS, publishStoredPackage } from "./helpers.mjs";

const headers = { cookie: `__Host-klippee_session=${SESSION_TOKEN}`, origin: WORKER_ORIGIN, "content-type": "application/json" };
const otherHeaders = { ...headers, cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
function request(path, method = "GET", body, auth = headers) {
  return dispatch(path, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(auth = headers) {
  const response = await request("/api/companion-assets", "POST", { asset: {
    title: `Old preset ${crypto.randomUUID()}`, kind: "filament", printerId: "printer_1", description: "Deletion fixture", tags: [],
    content: JSON.stringify({ type: "filament", name: "Old preset", filament_type: ["PLA"] }),
  } }, auth);
  assert.equal(response.status, 201);
  return (await response.json()).asset;
}
function remove(asset, baseline = asset.updatedAt, auth = headers) {
  return request(`/api/companion-assets/${encodeURIComponent(asset.id)}`, "DELETE", { updatedAt: baseline }, auth);
}

describe("hosted companion-asset deletion", () => {
  before(bootSharedWorker); after(disposeSharedWorker);

  it("requires authentication, trusted origin and ownership, without revealing foreign assets", async () => {
    const own = await create(), foreign = await create(otherHeaders);
    assert.equal((await remove(own, own.updatedAt, { ...headers, cookie: "" })).status, 401);
    assert.equal((await remove(own, own.updatedAt, { ...headers, origin: "https://attacker.test" })).status, 403);
    const denied = await remove(foreign), missing = await remove({ id: "missing", updatedAt: own.updatedAt });
    assert.equal(denied.status, 404); assert.equal(missing.status, 404);
    assert.deepEqual(await denied.json(), await missing.json());
    assert.equal((await request(`/api/companion-assets/${own.id}`, "DELETE", {})).status, 400);
    assert.equal((await request(`/api/companion-assets/${foreign.id}`, "GET", undefined, otherHeaders)).status, 200);
  });

  it("removes the hosted source from subsequent primary reads without changing a printer", async () => {
    const asset = await create();
    const printer = await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first();
    const response = await remove(asset);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deletedAssetId: asset.id });
    assert.equal((await request(`/api/companion-assets/${asset.id}`)).status, 404);
    const listed = await request("/api/companion-assets");
    assert.equal((await listed.json()).assets.some(candidate => candidate.id === asset.id), false);
    assert.deepEqual(await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first(), printer);
    const repeated = await remove(asset); assert.equal(repeated.status, 404);
    assert.equal((await repeated.json()).code, "companion_asset_not_found");
  });

  it("protects attachments added after the browser snapshot and keeps independent public links", async () => {
    let asset = await create();
    const publication = await request(`/api/companion-assets/${asset.id}/publish`, "POST");
    assert.equal(publication.status, 201);
    const published = await publication.json(); asset = published.asset;
    const packageRow = await db.prepare("SELECT package_json FROM private_packages WHERE user_id = 'user_1' AND package_id = 'package_1'").first();
    const attached = { ...JSON.parse(packageRow.package_json), companionAssetIds: [asset.id] };
    await db.prepare("UPDATE private_packages SET package_json = ? WHERE user_id = 'user_1' AND package_id = 'package_1'").bind(JSON.stringify(attached)).run();
    const config = await publishStoredPackage();
    const publicConfig = await db.prepare("SELECT id FROM public_packages WHERE slug = ?").bind(config.slug).first();
    await db.prepare("UPDATE public_companion_assets SET printer_config_id = ? WHERE user_id = 'user_1' AND source_asset_id = ?")
      .bind(publicConfig.id, asset.id).run();
    const publicBefore = await db.prepare("SELECT * FROM public_companion_assets WHERE user_id = 'user_1' AND source_asset_id = ?").bind(asset.id).first();
    assert.equal((await remove(asset)).status, 409);
    assert.equal((await request(`/api/companion-assets/${asset.id}`)).status, 200);
    await db.prepare("UPDATE private_packages SET package_json = ? WHERE user_id = 'user_1' AND package_id = 'package_1'").bind(packageRow.package_json).run();
    assert.equal((await remove(asset)).status, 200);
    assert.deepEqual(await db.prepare("SELECT * FROM public_companion_assets WHERE user_id = 'user_1' AND source_asset_id = ?").bind(asset.id).first(), publicBefore);
    const publicAsset = await request(`/api/public-companion-assets/${published.slug}`);
    assert.equal(publicAsset.status, 200);
    const body = await publicAsset.json();
    assert.equal(body.asset.content, asset.content);
    assert.equal(body.asset.printerConfig.slug, config.slug);
    const publicPackage = await request(`/api/packages/${config.slug}`);
    assert.equal(publicPackage.status, 200);
    assert.equal((await publicPackage.json()).package.companionAssets.some(candidate => candidate.id === asset.id), true);
  });

  it("does not match attachment substrings or attachments owned by another user", async () => {
    const asset = await create();
    const pkg = (await db.prepare("SELECT package_json FROM private_packages WHERE user_id = 'user_1' AND package_id = 'package_1'").first()).package_json;
    await db.prepare("UPDATE private_packages SET package_json = ? WHERE user_id = 'user_1' AND package_id = 'package_1'")
      .bind(JSON.stringify({ ...JSON.parse(pkg), companionAssetIds: [`${asset.id}-other`] })).run();
    const now = new Date().toISOString(), otherId = crypto.randomUUID();
    await db.prepare(`INSERT INTO private_packages (id,user_id,package_id,name,title,package_json,created_at,updated_at)
      VALUES (?, 'user_2', ?, 'other', 'Other', ?, ?, ?)`)
      .bind(otherId, otherId, JSON.stringify({ ...JSON.parse(pkg), companionAssetIds: [asset.id] }), now, now).run();
    try { assert.equal((await remove(asset)).status, 200); }
    finally { await db.prepare("UPDATE private_packages SET package_json = ? WHERE user_id = 'user_1' AND package_id = 'package_1'").bind(pkg).run(); }
    assert.ok(await db.prepare("SELECT id FROM private_packages WHERE id = ?").bind(otherId).first());
  });

  it("rejects stale deletion after a source edit", async () => {
    const asset = await create();
    const changed = await request("/api/companion-assets", "POST", { asset: { ...asset, title: "Edited in another browser" } });
    assert.equal(changed.status, 200);
    assert.equal((await remove(asset)).status, 409);
    const current = (await changed.json()).asset;
    assert.equal((await remove(current)).status, 200);
  });

  it("also deletes a legacy saved asset that is not Orca preset JSON", async () => {
    const id = crypto.randomUUID(), time = "2026-01-01T00:00:00.000Z";
    const asset = { id, kind: "slicer", title: "Legacy", description: "Old format", content: "old text", tags: [], public: false, version: "1", createdAt: time, updatedAt: time };
    await db.prepare(`INSERT INTO companion_assets (id,user_id,kind,title,asset_json,created_at,updated_at)
      VALUES (?, 'user_1', 'slicer', 'Legacy', ?, ?, ?)`).bind(id, JSON.stringify(asset), time, time).run();
    assert.equal((await remove(asset)).status, 200);
  });

  it("frees one companion-asset quota slot", async () => {
    const asset = await create(), prefix = `asset-quota-${crypto.randomUUID()}`;
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM companion_assets WHERE user_id = 'user_1'").first()).n;
    try {
      const ids = Array.from({ length: STORAGE_LIMITS.companionAssets - n }, (_, i) => `${prefix}-${i}`);
      if (ids.length) await db.batch(ids.map(id => db.prepare(`INSERT INTO companion_assets (id,user_id,kind,title,asset_json,created_at,updated_at)
        VALUES (?, 'user_1', 'filament', 'Filler', ?, ?, ?)`).bind(id, JSON.stringify({ ...asset, id }), asset.createdAt, asset.updatedAt)));
      assert.equal((await request("/api/companion-assets", "POST", { asset: { ...asset, id: crypto.randomUUID() } })).status, 409);
      assert.equal((await remove(asset)).status, 200);
      await create();
    } finally { await db.prepare("DELETE FROM companion_assets WHERE id LIKE ?").bind(`${prefix}%`).run(); }
  });
});
