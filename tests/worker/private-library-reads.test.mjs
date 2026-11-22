import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  bootSharedWorker, db, dispatch, disposeSharedWorker, insertPrivatePackage,
  SESSION_TOKEN, SECOND_SESSION_TOKEN, STORAGE_LIMITS, WORKER_ORIGIN,
} from "./helpers.mjs";

const owner = { cookie: `__Host-klippee_session=${SESSION_TOKEN}` };
const other = { cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
const files = content => [{ path: "printer.cfg", content: `[printer]\nkinematics: cartesian\n# ${content}\n`, public: false, role: "printer" }];
const assetInput = id => ({ id, kind: "filament", title: id, description: "Private read fixture", content: "{}", tags: [], version: "3" });

describe("Private package and companion-asset reads", () => {
  let base;
  async function post(path, body, headers = owner) {
    return dispatch(path, { method: "POST", body: JSON.stringify(body),
      headers: { ...headers, "content-type": "application/json", origin: WORKER_ORIGIN } });
  }
  async function get(path, headers = owner) {
    const response = await dispatch(path, { headers });
    assert.equal(response.status, 200);
    return response.json();
  }
  before(async () => {
    await bootSharedWorker();
    base = JSON.parse((await db.prepare("SELECT package_json FROM private_packages LIMIT 1").first()).package_json);
    const initial = await post("/api/private-packages", { package: { ...base, id: "shared-private-id", files: files("other owner") } }, other);
    assert.equal(initial.status, 201, "an owner with no packages can save their first package");
    for (const [id, headers] of [["private-first", owner], ["private-second", owner], ["private-foreign", other]]) {
      assert.equal((await post("/api/companion-assets", { asset: assetInput(id) }, headers)).status, 201);
    }
    await insertPrivatePackage("shared-private-id", files("owner copy"), [], [],
      ["private-second", "private-foreign", "private-first", "private-second", "missing"]);
    await insertPrivatePackage("other-only", files("foreign package"), [], [], [], "user_2");
    await insertPrivatePackage("broken-private", files("broken"));
    await db.batch([
      db.prepare("UPDATE private_packages SET updated_at = '2090-01-01' WHERE user_id = 'user_1' AND package_id = 'shared-private-id'"),
      db.prepare("UPDATE private_packages SET package_json = 'not-json', updated_at = '2099-01-01' WHERE package_id = 'broken-private'"),
      db.prepare("UPDATE companion_assets SET updated_at = '2090-01-01' WHERE id = 'private-second'"),
      db.prepare(`INSERT INTO companion_assets (id,user_id,kind,title,asset_json,created_at,updated_at)
        VALUES ('broken-asset','user_1','filament','Broken','not-json','2000-01-01','2099-01-01')`),
    ]);
  });
  after(disposeSharedWorker);

  it("keeps private lists owner-scoped, ordered and filtered, with content-free package summaries", async () => {
    const { packages } = await get("/api/private-packages");
    assert.equal(packages[0].id, "shared-private-id");
    assert(packages.every(pkg => pkg.id !== "other-only" && pkg.id !== "broken-private"));
    assert(packages.every(pkg => pkg.files.every(file => file.content === "")));
    assert.equal(packages[0].cloudUpdatedAt, "2090-01-01");
    const { assets } = await get("/api/companion-assets");
    assert.deepEqual(assets.map(asset => asset.id), ["private-second", "private-first"]);
    assert(assets.every(asset => !Object.hasOwn(asset, "user_id") && !Object.hasOwn(asset, "asset_json")));
    assert.deepEqual((await get("/api/companion-assets", other)).assets.map(asset => asset.id), ["private-foreign"]);
  });

  it("loads the caller's copy of a package and deduplicates attachments in requested order", async () => {
    const owned = (await get("/api/private-packages/shared-private-id")).package;
    const foreign = (await get("/api/private-packages/shared-private-id", other)).package;
    assert.match(owned.files[0].content, /owner copy/);
    assert.match(foreign.files[0].content, /other owner/);
    assert.deepEqual(owned.companionAssets.map(asset => asset.id), ["private-second", "private-first"]);
    assert.deepEqual(foreign.companionAssets, []);
  });

  it("preserves missing/foreign and malformed-data responses", async () => {
    for (const [path, status] of [
      ["/api/private-packages/other-only", 404], ["/api/private-packages/missing", 404],
      ["/api/private-packages/broken-private", 422], ["/api/companion-assets/private-foreign", 404],
      ["/api/companion-assets/missing", 404], ["/api/companion-assets/broken-asset", 404],
    ]) {
      assert.equal((await dispatch(path, { headers: owner })).status, status, path);
    }
    const publish = await post("/api/companion-assets/private-foreign/publish", {});
    assert.equal(publish.status, 404);
  });

  it("allows existing package saves at quota while rejecting new ones for that owner", async () => {
    const { count } = await db.prepare("SELECT COUNT(*) AS count FROM private_packages WHERE user_id = 'user_1'").first();
    await db.batch(Array.from({ length: STORAGE_LIMITS.privatePackages - count }, (_, index) => db.prepare(`INSERT INTO private_packages
      (id,user_id,package_id,name,title,package_json,created_at,updated_at)
      VALUES (?,'user_1',?,?,'Quota','{}','2000-01-01','2000-01-01')`)
      .bind(`private-quota-${index}`, `private-quota-${index}`, `private-quota-${index}`)));
    const pkg = { ...base, id: "new-at-quota", files: files("quota save") };
    assert.equal((await post("/api/private-packages", { package: pkg })).status, 409);
    assert.equal((await post("/api/private-packages", { package: { ...pkg, id: "shared-private-id" } })).status, 201);
    assert.equal((await post("/api/private-packages", { package: pkg }, other)).status, 201);
  });

  it("keeps asset creation time, publication state and version during updates at quota", async () => {
    const before = (await get("/api/companion-assets/private-first")).asset;
    const { count } = await db.prepare("SELECT COUNT(*) AS count FROM companion_assets WHERE user_id = 'user_1'").first();
    await db.batch(Array.from({ length: STORAGE_LIMITS.companionAssets - count }, (_, index) => db.prepare(`INSERT INTO companion_assets
      (id,user_id,kind,title,asset_json,created_at,updated_at)
      VALUES (?,'user_1','filament','Quota','{}','2000-01-01','2000-01-01')`).bind(`asset-quota-${index}`)));
    assert.equal((await post("/api/companion-assets", { asset: assetInput("new-asset-at-quota") })).status, 409);
    const updated = await post("/api/companion-assets", { asset: { ...assetInput("private-first"), version: undefined, public: true } });
    assert.equal(updated.status, 200);
    const { asset } = await updated.json();
    assert.equal(asset.createdAt, before.createdAt);
    assert.equal(asset.public, false);
    assert.equal(asset.version, "3");
    assert.equal((await post("/api/companion-assets", { asset: assetInput("other-asset-below-quota") }, other)).status, 201);
  });
});
