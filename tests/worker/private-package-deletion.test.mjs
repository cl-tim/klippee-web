import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { bootSharedWorker, disposeSharedWorker, db, dispatch, mf, SESSION_TOKEN, SECOND_SESSION_TOKEN,
  WORKER_ORIGIN, sha256Hex, STORAGE_LIMITS, armPublicListingPatchHook } from "./helpers.mjs";

const headers = { cookie: `__Host-klippee_session=${SESSION_TOKEN}`, origin: WORKER_ORIGIN, "content-type": "application/json" };
const otherHeaders = { ...headers, cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
function request(path, method = "GET", body, auth = headers) {
  return dispatch(path, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function definition() {
  const id = `delete-package-${crypto.randomUUID()}`;
  return { id, name: id, title: "Obsolete private package", description: "Deletion fixture", version: "1", printer: "Test",
    tags: ["private"], hardware: [], warnings: [], variables: [],
    files: [{ path: "printer.cfg", content: `# ${id}\n`, role: "printer", public: true }] };
}
async function save(pkg, auth = headers) {
  const response = await request("/api/private-packages", "POST", { package: pkg }, auth);
  assert.equal(response.status, 201);
  return pkg;
}
async function inventory() {
  const response = await request("/api/private-packages?manage=1");
  assert.equal(response.status, 200);
  return (await response.json()).packages;
}
async function expected(id) {
  const row = (await inventory()).find(row => row.id === id);
  assert.ok(row);
  return { updatedAt: row.updated_at };
}
async function remove(pkg, baseline, auth) {
  return request(`/api/private-packages/${encodeURIComponent(pkg.id)}`, "DELETE", baseline ?? await expected(pkg.id), auth);
}
async function publish(pkg) {
  const response = await request("/api/public-packages", "POST", { packageId: pkg.id, acknowledgeSafetyWarnings: true });
  assert.equal(response.status, 201);
  return (await response.json()).package.publicSlug;
}

describe("private package deletion", () => {
  before(bootSharedWorker); after(disposeSharedWorker);

  it("requires authentication, trusted origin and ownership; inventories contain no private definitions", async () => {
    const own = await save(definition()), foreign = await save(definition(), otherHeaders);
    const baseline = await expected(own.id);
    const rows = await inventory();
    assert.equal(rows.some(row => row.id === foreign.id), false);
    assert.deepEqual(Object.keys(rows.find(row => row.id === own.id)).sort(),
      ["id", "name", "title", "updated_at", "linked_printer_count", "published_listing_count"].sort());
    assert.equal((await request("/api/private-packages?manage=1", "GET", undefined, { ...headers, cookie: "" })).status, 401);
    assert.equal((await remove(own, baseline, { ...headers, cookie: "" })).status, 401);
    assert.equal((await remove(own, baseline, { ...headers, origin: "https://attacker.test" })).status, 403);
    const denied = await remove(foreign, baseline), missing = await remove({ id: "missing" }, baseline);
    assert.equal(denied.status, 404); assert.equal(missing.status, 404);
    assert.deepEqual(await denied.json(), await missing.json());
    assert.equal((await remove(own, {})).status, 400);
  });

  it("deletes only the private copy; public snapshots, other owners, bodies, claims and leases survive", async () => {
    const pkg = await save(definition());
    pkg.files.push({ path: "klippee_variables.cfg", content: `# private ${pkg.id}\n`, role: "macro", public: false });
    await save(pkg); await save(pkg, otherHeaders);
    const slug = await publish(pkg);
    const publicBefore = await db.prepare("SELECT * FROM public_packages WHERE slug = ?").bind(slug).first();
    assert.equal((await inventory()).find(row => row.id === pkg.id).published_listing_count, 1);
    const privateId = (await db.prepare("SELECT id FROM private_packages WHERE user_id = 'user_1' AND package_id = ?").bind(pkg.id).first()).id;
    const hashes = await Promise.all(pkg.files.map(file => sha256Hex(file.content)));
    await db.prepare(`INSERT INTO canonical_blob_write_leases (lease_id,user_id,sha256,created_at,expires_at)
      VALUES ('private-delete-inflight', 'user_1', ?, '2026-01-01', '2099-01-01')`).bind(hashes[1]).run();
    const claims = (await db.prepare("SELECT * FROM user_blob_claims ORDER BY user_id,sha256").all()).results;
    const printer = await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first();
    const response = await remove(pkg);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deletedPackageId: pkg.id });
    assert.equal((await request(`/api/private-packages/${pkg.id}`)).status, 404);
    assert.equal((await request(`/api/private-packages/${pkg.id}`, "GET", undefined, otherHeaders)).status, 200);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM canonical_blob_private_package_refs WHERE private_package_id = ?").bind(privateId).first()).n, 0);
    assert.deepEqual(await db.prepare("SELECT * FROM public_packages WHERE slug = ?").bind(slug).first(), publicBefore);
    const publicCopy = await request(`/api/packages/${slug}`);
    assert.equal(publicCopy.status, 200);
    assert.equal((await publicCopy.json()).package.files.length, 1);
    assert.equal((await request(`/api/public-packages/${slug}/status`)).status, 200);
    const bucket = await mf.getR2Bucket("BLOBS");
    for (const [i, hash] of hashes.entries()) assert.equal(await (await bucket.get(`blobs/sha256/${hash}`)).text(), pkg.files[i].content);
    assert.deepEqual((await db.prepare("SELECT * FROM user_blob_claims ORDER BY user_id,sha256").all()).results, claims);
    assert.ok(await db.prepare("SELECT * FROM canonical_blob_write_leases WHERE lease_id = 'private-delete-inflight'").first());
    assert.deepEqual(await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first(), printer);
    assert.equal((await remove(pkg, { updatedAt: "old" })).status, 404);
    const edit = await request(`/api/public-packages/${slug}`, "PATCH", {
      title: "Still editable", description: "Public snapshot remains owned", printer: "Test", tags: [], hardware: [],
    });
    assert.equal(edit.status, 200);
    assert.equal(await db.prepare("SELECT id FROM private_packages WHERE user_id = 'user_1' AND package_id = ?").bind(pkg.id).first(), null);
  });

  it("rechecks newly added bindings and retains their secret classification", async () => {
    const pkg = definition();
    pkg.variables = [{ name: "beacon_serial", label: "Host serial", description: "Host-local value", type: "text", required: false, secret: true }];
    await save(pkg); const baseline = await expected(pkg.id);
    const original = await db.prepare("SELECT package_ids_json,variable_values_json FROM printers WHERE id = 'printer_1'").first();
    await db.prepare("UPDATE printers SET package_ids_json = ?, variable_values_json = ? WHERE id = 'printer_1'")
      .bind(JSON.stringify([pkg.id]), JSON.stringify({ beacon_serial: "legacy-sensitive" })).run();
    const before = await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first();
    try {
      assert.equal((await inventory()).find(row => row.id === pkg.id).linked_printer_count, 1);
      assert.equal((await remove(pkg, baseline)).status, 409);
      assert.deepEqual(await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first(), before);
      const patch = await request("/api/printers/printer_1/variables/beacon_serial", "PATCH", { value: "must-stay-local" });
      assert.equal(patch.status, 200); assert.equal((await patch.json()).stored, false);
    } finally {
      await db.prepare("UPDATE printers SET package_ids_json = ?, variable_values_json = ? WHERE id = 'printer_1'")
        .bind(original.package_ids_json, original.variable_values_json).run();
    }
    assert.equal((await remove(pkg, baseline)).status, 200);
  });

  it("keeps secret filtering for printers bound to an independent public snapshot", async () => {
    const pkg = definition();
    pkg.variables = [{ name: "beacon_serial", label: "Serial", description: "Host-local", type: "text", secret: true, required: false }];
    pkg.files[0].content = "# Serial ${KLIPPEE:beacon_serial}\n";
    await save(pkg); const slug = await publish(pkg);
    const previous = await db.prepare("SELECT package_ids_json FROM printers WHERE id = 'printer_1'").first();
    await db.prepare("UPDATE printers SET package_ids_json = ? WHERE id = 'printer_1'").bind(JSON.stringify([slug])).run();
    try {
      assert.equal((await remove(pkg)).status, 200);
      const response = await request("/api/printers/printer_1/variables/beacon_serial", "PATCH", { value: "keep-local" });
      assert.equal(response.status, 200); assert.equal((await response.json()).stored, false);
      assert.equal((await db.prepare("SELECT package_ids_json FROM printers WHERE id = 'printer_1'").first()).package_ids_json, JSON.stringify([slug]));
    } finally {
      await db.prepare("UPDATE printers SET package_ids_json = ? WHERE id = 'printer_1'").bind(previous.package_ids_json).run();
    }
  });

  it("ignores another owner's bindings and does not match package-id substrings", async () => {
    const pkg = await save(definition());
    await db.prepare(`INSERT INTO printers (id,user_id,name,package_ids_json,created_at,updated_at)
      VALUES ('foreign-private-binding','user_2','Other owner',?,'2026-01-01','2026-01-01')`).bind(JSON.stringify([pkg.id])).run();
    await db.prepare("UPDATE printers SET package_ids_json = ? WHERE id = 'printer_1'").bind(JSON.stringify([`${pkg.id}-other`])).run();
    try { assert.equal((await remove(pkg)).status, 200); }
    finally { await db.prepare("UPDATE printers SET package_ids_json = '[]' WHERE id = 'printer_1'").run(); }
  });

  it("rejects stale inventories after a private package edit", async () => {
    const pkg = await save(definition()), baseline = await expected(pkg.id);
    await db.prepare("UPDATE private_packages SET updated_at = '2090-01-01' WHERE user_id = 'user_1' AND package_id = ?").bind(pkg.id).run();
    assert.equal((await remove(pkg, baseline)).status, 409);
    assert.equal((await remove(pkg)).status, 200);
  });

  it("does not recreate a deleted source during an in-flight public listing edit", async () => {
    const pkg = await save(definition()), slug = await publish(pkg), baseline = await expected(pkg.id);
    const hook = armPublicListingPatchHook();
    const editing = request(`/api/public-packages/${slug}`, "PATCH", {
      title: "Concurrent change", description: "Edit", printer: "Test", hardware: [], tags: [],
    });
    await hook.reached;
    try { assert.equal((await remove(pkg, baseline)).status, 200); }
    finally { hook.release(); }
    assert.equal((await editing).status, 409);
    assert.equal((await request(`/api/private-packages/${pkg.id}`)).status, 404);
    assert.equal((await request(`/api/packages/${slug}`)).status, 200);
  });

  it("frees a private-package quota slot", async () => {
    const pkg = await save(definition()), prefix = `quota-delete-${crypto.randomUUID()}`;
    const count = (await inventory()).length, timestamp = new Date().toISOString();
    try {
      const ids = Array.from({ length: STORAGE_LIMITS.privatePackages - count }, (_, i) => `${prefix}-${i}`);
      if (ids.length) await db.batch(ids.map(id => db.prepare(`INSERT INTO private_packages
        (id,user_id,package_id,name,title,package_json,created_at,updated_at) VALUES (?, 'user_1', ?, ?, ?, ?, ?, ?)`)
        .bind(id,id,id,id,JSON.stringify({ ...pkg,id }),timestamp,timestamp)));
      assert.equal((await request("/api/private-packages", "POST", { package: definition() })).status, 409);
      assert.equal((await remove(pkg)).status, 200);
      await save(definition());
    } finally { await db.prepare("DELETE FROM private_packages WHERE id LIKE ?").bind(`${prefix}%`).run(); }
  });
});
