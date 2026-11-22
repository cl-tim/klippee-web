import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  SESSION_TOKEN, SECOND_SESSION_TOKEN, WORKER_ORIGIN, STORAGE_LIMITS,
  bootSharedWorker, disposeSharedWorker, db, dispatch, mf, hashToken, sha256Hex,
} from "./helpers.mjs";

const headers = {
  cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
  "content-type": "application/json",
  origin: WORKER_ORIGIN,
};
const otherHeaders = { ...headers, cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
function request(path, method = "GET", body, auth = headers) {
  return dispatch(path, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function file(content) {
  return { path: "printer.cfg", role: "printer", public: false, content };
}
async function create(files = [], auth = headers) {
  const response = await request("/api/repos", "POST", {
    title: `Old saved configuration ${crypto.randomUUID()}`, ...(files.length ? { files } : { empty: true }),
  }, auth);
  assert.equal(response.status, 201);
  return response.json();
}
async function inventory() {
  const response = await request("/api/repos?manage=1");
  assert.equal(response.status, 200);
  return (await response.json()).repositories;
}
async function snapshot(id) {
  const row = (await inventory()).find(row => row.id === id);
  assert.ok(row);
  return { updatedAt: row.updated_at, latestVersionId: row.latest_version_id };
}

describe("saved cloud configuration deletion", () => {
  before(bootSharedWorker);
  after(disposeSharedWorker);

  it("lists only owned summaries and requires authentication and same-origin writes", async () => {
    const index = await db.prepare("PRAGMA index_info('idx_repository_versions_previous_version_id')").all();
    assert.deepEqual(index.results.map(column => column.name), ["previous_version_id"]);
    const foreign = await create([], otherHeaders);
    const own = await create();
    const rows = await inventory();
    assert.equal(rows.some(row => row.id === foreign.repository.id), false);
    assert.equal(rows.find(row => row.id === own.repository.id).version_count, 0);
    assert.equal(rows.find(row => row.id === "repo_1").linked_printer_count, 1);
    for (const row of rows) {
      assert.equal("pending_files_json" in row, false);
      assert.equal("user_id" in row, false);
    }
    const body = await snapshot(own.repository.id);
    assert.equal((await request("/api/repos?manage=1", "GET", undefined, { ...headers, cookie: "" })).status, 401);
    assert.equal((await request(`/api/repos/${own.repository.id}`, "DELETE", body, { ...headers, cookie: "" })).status, 401);
    assert.equal((await request(`/api/repos/${own.repository.id}`, "DELETE", body, { ...headers, origin: "https://attacker.test" })).status, 403);
    const foreignDelete = await request(`/api/repos/${foreign.repository.id}`, "DELETE", body);
    const missingDelete = await request("/api/repos/does-not-exist", "DELETE", body);
    assert.equal(foreignDelete.status, 404);
    assert.equal(missingDelete.status, 404);
    assert.deepEqual(await foreignDelete.json(), await missingDelete.json());
    assert.equal((await request(`/api/repos/${own.repository.id}`, "DELETE", {})).status, 400);
    assert.ok(await db.prepare("SELECT id FROM repositories WHERE id = ?").bind(own.repository.id).first());
  });

  it("removes drafts, full history and credentials atomically while retaining shared bodies, claims and leases", async () => {
    const content = `[printer]\nkinematics: corexy\n# ${crypto.randomUUID()}\n`;
    const unique = `${content}# only this history\n`;
    const old = await create([file(content)]);
    const survivor = await create([file(content)], otherHeaders);
    const id = old.repository.id;
    assert.equal((await request(`/api/repos/${id}/versions`, "POST", { files: [file(unique)] })).status, 201);
    const timestamp = "2090-01-01T00:00:00.000Z";
    await db.prepare("UPDATE repositories SET pending_files_json = ?, pending_updated_at = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify([file("# unsaved old draft\n")]), timestamp, timestamp, id).run();
    const token = `klp_${crypto.randomUUID()}`;
    await db.prepare(`INSERT INTO sync_tokens (id, user_id, repository_id, name, token_hash, token_prefix, scopes_json, created_at)
      VALUES (?, 'user_1', ?, 'old token', ?, 'klp_', '["pull"]', ?)`)
      .bind(crypto.randomUUID(), id, await hashToken(token), timestamp).run();
    const bucket = await mf.getR2Bucket("BLOBS");
    const key = `diagnostics/user_1/${crypto.randomUUID()}/klippy.log`;
    await bucket.put(key, "old diagnostic");
    await db.prepare(`INSERT INTO diagnostic_uploads (id, user_id, printer_id, repository_id, file_name, content_type,
      size_bytes, original_size_bytes, truncated, r2_key, created_at, expires_at)
      VALUES (?, 'user_1', 'printer_1', ?, 'klippy.log', 'text/plain', 14, 14, 0, ?, ?, '2099-01-01T00:00:00.000Z')`)
      .bind(crypto.randomUUID(), id, key, timestamp).run();
    const uniqueHash = await sha256Hex(unique), sharedHash = await sha256Hex(content);
    await db.prepare(`INSERT INTO canonical_blob_write_leases (lease_id, user_id, sha256, created_at, expires_at)
      VALUES ('other-inflight-save', 'user_1', ?, ?, '2099-01-01T00:00:00.000Z')`).bind(uniqueHash, timestamp).run();
    const claims = (await db.prepare("SELECT * FROM user_blob_claims ORDER BY user_id, sha256").all()).results;
    const budget = (await db.prepare("SELECT * FROM canonical_blob_budget_total").all()).results;
    const printer = await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first();
    const row = (await inventory()).find(row => row.id === id);
    assert.equal(row.version_count, 2);
    assert.equal(row.pending_draft, 1);
    const response = await request(`/api/repos/${id}`, "DELETE", await snapshot(id));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deletedRepositoryId: id });
    for (const table of ["repository_versions", "sync_tokens", "diagnostic_uploads", "canonical_blob_pending_refs"]) {
      assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repository_id = ?`).bind(id).first()).n, 0);
    }
    assert.equal(await db.prepare("SELECT id FROM repositories WHERE id = ?").bind(id).first(), null);
    assert.equal((await request(`/api/sync/repos/${id}/pull`, "GET", undefined, { authorization: `Bearer ${token}` })).status, 401);
    assert.equal(await bucket.head(key), null);
    assert.equal(await (await bucket.get(`blobs/sha256/${sharedHash}`)).text(), content);
    assert.equal(await (await bucket.get(`blobs/sha256/${uniqueHash}`)).text(), unique);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM canonical_blob_repository_version_refs WHERE sha256 = ?").bind(sharedHash).first()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM canonical_blob_repository_version_refs WHERE sha256 = ?").bind(uniqueHash).first()).n, 0);
    assert.deepEqual((await db.prepare("SELECT * FROM user_blob_claims ORDER BY user_id, sha256").all()).results, claims);
    assert.deepEqual((await db.prepare("SELECT * FROM canonical_blob_budget_total").all()).results, budget);
    assert.ok(await db.prepare("SELECT lease_id FROM canonical_blob_write_leases WHERE lease_id = 'other-inflight-save'").first());
    assert.deepEqual(await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first(), printer);
    assert.equal((await request(`/api/repos/${survivor.repository.id}/versions`, "GET", undefined, otherHeaders)).status, 200);
    assert.equal((await request(`/api/repos/${id}`, "DELETE", { updatedAt: timestamp, latestVersionId: null })).status, 404);
  });

  it("refuses printer bindings added after inventory, preserving printer state", async () => {
    const old = await create();
    const id = old.repository.id, expected = await snapshot(id);
    await db.prepare("UPDATE printers SET repository_id = ? WHERE id = 'printer_1'").bind(id).run();
    const before = await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first();
    try {
      assert.equal((await request(`/api/repos/${id}`, "DELETE", expected)).status, 409);
      assert.deepEqual(await db.prepare("SELECT * FROM printers WHERE id = 'printer_1'").first(), before);
      assert.ok(await db.prepare("SELECT id FROM repositories WHERE id = ?").bind(id).first());
    } finally {
      await db.prepare("UPDATE printers SET repository_id = 'repo_1' WHERE id = 'printer_1'").run();
    }
  });

  it("rejects deletion after a new draft is saved without advancing history", async () => {
    const old = await create();
    const id = old.repository.id, expected = await snapshot(id);
    const staged = await request(`/api/repos/${id}/pending`, "PUT", {
      baseRevision: null, files: [file("[printer]\nkinematics: corexy\n")],
    });
    assert.equal(staged.status, 200);
    assert.equal((await request(`/api/repos/${id}`, "DELETE", expected)).status, 409);
    assert.equal((await inventory()).find(row => row.id === id).pending_draft, 1);
    assert.equal((await request(`/api/repos/${id}`, "DELETE", await snapshot(id))).status, 200);
  });

  it("rolls back the entire deletion and retains private objects if a credential cascade fails", async () => {
    const old = await create([file(`[printer]\nkinematics: corexy\n# rollback ${crypto.randomUUID()}\n`)]);
    const id = old.repository.id, expected = await snapshot(id), key = `diagnostics/rollback-${crypto.randomUUID()}`;
    const bucket = await mf.getR2Bucket("BLOBS");
    await bucket.put(key, "diagnostic");
    await db.prepare(`INSERT INTO diagnostic_uploads (id,user_id,printer_id,repository_id,file_name,content_type,
      size_bytes,original_size_bytes,truncated,r2_key,created_at,expires_at)
      VALUES (?, 'user_1', 'printer_1', ?, 'klippy.log', 'text/plain', 10, 10, 0, ?, ?, '2099-01-01T00:00:00.000Z')`)
      .bind(crypto.randomUUID(), id, key, expected.updatedAt).run();
    await db.prepare(`INSERT INTO sync_tokens (id,user_id,repository_id,name,token_hash,token_prefix,scopes_json,created_at)
      VALUES (?, 'user_1', ?, 'rollback-fixture', ?, 'klp_', '["pull"]', ?)`)
      .bind(crypto.randomUUID(), id, await hashToken(crypto.randomUUID()), expected.updatedAt).run();
    await db.prepare(`CREATE TRIGGER reject_configuration_token_delete BEFORE DELETE ON sync_tokens
      WHEN OLD.name = 'rollback-fixture' BEGIN SELECT RAISE(ABORT, 'fixture deletion failure'); END`).run();
    try {
      assert.equal((await request(`/api/repos/${id}`, "DELETE", expected)).status, 500);
      assert.ok(await db.prepare("SELECT id FROM repositories WHERE id = ?").bind(id).first());
      for (const table of ["repository_versions", "sync_tokens", "diagnostic_uploads"]) {
        assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repository_id = ?`).bind(id).first()).n, 1);
      }
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM canonical_blob_repository_version_refs WHERE version_id = ?").bind(old.version.id).first()).n, 1);
      assert.equal(await (await bucket.get(key)).text(), "diagnostic");
    } finally {
      await db.prepare("DROP TRIGGER reject_configuration_token_delete").run();
    }
    assert.equal((await request(`/api/repos/${id}`, "DELETE", expected)).status, 200);
  });

  it("protects both public listing links and approved-version provenance, even when added after inventory", async () => {
    const old = await create([file("[printer]\nkinematics: cartesian\n")]);
    const id = old.repository.id, expected = await snapshot(id), listing = crypto.randomUUID();
    await db.prepare(`INSERT INTO public_packages (id,user_id,source_package_id,slug,name,title,package_json,created_at,updated_at,published_at)
      VALUES (?, 'user_1', 'legacy', ?, 'legacy', 'Legacy', '{}', ?, ?, ?)`)
      .bind(listing, listing, expected.updatedAt, expected.updatedAt, expected.updatedAt).run();
    try {
      for (const [repo, version] of [[id, null], [null, old.version.id], [id, old.version.id]]) {
        await db.prepare("UPDATE public_packages SET repository_id = ?, approved_version_id = ? WHERE id = ?").bind(repo, version, listing).run();
        assert.equal((await inventory()).find(row => row.id === id).published_listing_count, 1);
        assert.equal((await request(`/api/repos/${id}`, "DELETE", expected)).status, 409);
        assert.equal((await db.prepare("SELECT approved_version_id FROM public_packages WHERE id = ?").bind(listing).first()).approved_version_id, version);
      }
    } finally {
      await db.prepare("DELETE FROM public_packages WHERE id = ?").bind(listing).run();
    }
    assert.equal((await request(`/api/repos/${id}`, "DELETE", expected)).status, 200);
  });

  it("protects history referenced by another configuration and rejects stale deletion snapshots", async () => {
    const old = await create([file("[printer]\nkinematics: corexy\n")]);
    const dependent = await create([file("[printer]\nkinematics: cartesian\n")]);
    const id = old.repository.id, expected = await snapshot(id);
    await db.prepare("UPDATE repository_versions SET previous_version_id = ? WHERE id = ?").bind(old.version.id, dependent.version.id).run();
    assert.equal((await inventory()).find(row => row.id === id).dependent_version_count, 1);
    assert.equal((await request(`/api/repos/${id}`, "DELETE", expected)).status, 409);
    await db.prepare("UPDATE repository_versions SET previous_version_id = NULL WHERE id = ?").bind(dependent.version.id).run();
    assert.equal((await request(`/api/repos/${id}/versions`, "POST", { files: [file("[printer]\nkinematics: delta\n")] })).status, 201);
    assert.equal((await request(`/api/repos/${id}`, "DELETE", expected)).status, 409);
    assert.equal((await inventory()).find(row => row.id === id).version_count, 2);
    assert.equal((await request(`/api/repos/${id}`, "DELETE", await snapshot(id))).status, 200);
  });

  it("frees a configuration slot, including deletion of an empty saved configuration", async () => {
    const old = await create();
    const count = (await inventory()).length;
    const prefix = `quota-delete-${crypto.randomUUID()}`;
    const time = new Date().toISOString();
    try {
      const fillers = Array.from({ length: STORAGE_LIMITS.repositories - count }, (_, i) => `${prefix}-${i}`);
      if (fillers.length) await db.batch(fillers.map(id => db.prepare(`INSERT INTO repositories
        (id,user_id,name,title,created_at,updated_at) VALUES (?, 'user_1', ?, 'Quota filler', ?, ?)`).bind(id, id, time, time)));
      assert.equal((await request("/api/repos", "POST", { title: "Over quota", empty: true })).status, 409);
      assert.equal((await request(`/api/repos/${old.repository.id}`, "DELETE", await snapshot(old.repository.id))).status, 200);
      await create();
    } finally {
      await db.prepare("DELETE FROM repositories WHERE id LIKE ?").bind(`${prefix}%`).run();
    }
  });
});
