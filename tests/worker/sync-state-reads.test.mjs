import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bootSharedWorker, db, dispatch, disposeSharedWorker, hashToken } from "./helpers.mjs";

const timestamp = "2026-01-01T00:00:00.000Z";
const files = label => [{ path: "printer.cfg", role: "printer", public: false, content: `# ${label}\n[printer]\nkinematics: corexy\n` }];

describe("Desired configuration and printer-sync read contracts", () => {
  before(bootSharedWorker);
  after(disposeSharedWorker);

  async function version(repositoryId, number, content = JSON.stringify(files(`${repositoryId}-${number}`))) {
    const id = `${repositoryId}-v${number}`;
    await db.prepare(`INSERT INTO repository_versions
      (id,repository_id,version_number,message,source,files_json,created_at) VALUES (?,?,?,?,'web-editor',?,?)`)
      .bind(id, repositoryId, number, `Version ${number}`, content, timestamp).run();
    return id;
  }

  async function printer(id, repositoryId, userId = "user_1") {
    await db.prepare(`INSERT INTO printers (id,user_id,name,repository_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .bind(id, userId, `  ${id}  `, repositoryId, timestamp, timestamp).run();
  }

  async function fixture(label, { empty = false, bound = true } = {}) {
    const repositoryId = `sync-state-${label}`;
    const printerId = `${repositoryId}-printer`;
    await db.prepare(`INSERT INTO repositories (id,user_id,name,title,created_at,updated_at) VALUES (?,'user_1',?,?,?,?)`)
      .bind(repositoryId, label, label, timestamp, timestamp).run();
    if (!empty) {
      const id = await version(repositoryId, 1);
      await db.prepare("UPDATE repositories SET latest_version_id = ? WHERE id = ?").bind(id, repositoryId).run();
    }
    if (bound) await printer(printerId, repositoryId);
    const token = `klp_${repositoryId}`;
    await db.prepare(`INSERT INTO sync_tokens
      (id,user_id,repository_id,printer_id,name,token_hash,token_prefix,scopes_json,created_at)
      VALUES (?,'user_1',?,?,'State read token',?,'klp_state','["repo:read","repo:write"]',?)`)
      .bind(repositoryId, repositoryId, bound ? printerId : null, await hashToken(token), timestamp).run();
    const call = (path = "pull", body) => dispatch(`/api/sync/repos/${repositoryId}/${path}`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    return { repositoryId, printerId, call };
  }

  async function pull(call) {
    const response = await call();
    assert.equal(response.status, 200);
    return response.json();
  }

  it("uses the stored latest pointer and lets a draft override it without creating history", async () => {
    const { repositoryId, call } = await fixture("pointer");
    await version(repositoryId, 7);
    const original = await pull(call);
    assert.equal(original.version.id, `${repositoryId}-v1`);
    assert.equal(original.version.version_number, 1);
    const draft = files("draft overrides retained history");
    await db.prepare("UPDATE repositories SET pending_files_json = ?, pending_updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(draft), timestamp, repositoryId).run();
    const pending = await pull(call);
    assert.deepEqual(pending.version.files, draft);
    assert.equal(pending.version.id, null);
    assert.equal(pending.version.previous_version_id, original.version.id);
    assert.equal(pending.version.version_number, 2);
    assert.equal(pending.version.created_at, timestamp);
    assert.equal(pending.version.source, "pending");
    assert.equal(pending.desired.pending, true);
    assert.notEqual(pending.version.revision, original.version.revision);
    const total = await db.prepare("SELECT COUNT(*) AS count FROM repository_versions WHERE repository_id = ?").bind(repositoryId).first();
    assert.equal(total.count, 2);
    await db.prepare("UPDATE repositories SET pending_files_json = NULL WHERE id = ?").bind(repositoryId).run();
    assert.deepEqual((await pull(call)).version, original.version);
  });

  it("preserves empty and missing-pointer states, including a first draft without a retained version", async () => {
    for (const missingPointer of [false, true]) {
      const { repositoryId, call } = await fixture(`empty-${missingPointer}`, { empty: true });
      if (missingPointer) {
        await db.prepare("UPDATE repositories SET latest_version_id = 'missing-version' WHERE id = ?").bind(repositoryId).run();
      }
      const empty = await pull(call);
      assert.equal(empty.desired, null);
      assert.equal(empty.version, null);
      const snapshot = await call("snapshot.sh");
      assert.equal(snapshot.status, 404);
      assert.deepEqual(await snapshot.json(), { error: "No repository versions found" });
      await db.prepare("UPDATE repositories SET pending_files_json = ?, pending_updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(files("first draft")), timestamp, repositoryId).run();
      const pending = await pull(call);
      assert.equal(pending.version.version_number, 1);
      assert.equal(pending.version.previous_version_id, null);
      assert.equal(pending.version.id, null);
      assert.equal(pending.desired.pending, true);
    }
  });

  it("returns 422 for malformed desired files and missing R2 content", async () => {
    // The D1 reference ledger exists, but its R2 object is missing.
    await db.prepare("INSERT INTO canonical_blobs (sha256,size_bytes,charge_bytes,created_at) VALUES (?,1,65536,?)")
      .bind("f".repeat(64), timestamp).run();
    const missingBlob = JSON.stringify({ storage: "r2-blobs", version: 2, entries: [{
      path: "printer.cfg", role: "printer", public: false, byteLength: 1, sha256: "f".repeat(64),
    }] });
    for (const [label, pending, content] of [["bad-version", false, "{"], ["bad-draft", true, "{"], ["missing-blob", false, missingBlob]]) {
      const { repositoryId, call } = await fixture(label);
      await (pending
        ? db.prepare("UPDATE repositories SET pending_files_json = ? WHERE id = ?").bind(content, repositoryId)
        : db.prepare("UPDATE repository_versions SET files_json = ? WHERE repository_id = ?").bind(content, repositoryId)).run();
      for (const path of ["pull", "status.txt", "snapshot.sh"]) {
        const response = await call(path);
        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), { error: "Stored desired configuration is invalid" });
      }
    }
  });

  it("does not expose a bound printer after its owner or repository changes", async () => {
    const { repositoryId, printerId, call } = await fixture("binding");
    for (const [userId, boundRepository] of [["user_2", repositoryId], ["user_1", "repo_other"], ["user_1", null]]) {
      await db.prepare("UPDATE printers SET user_id = ?, repository_id = ? WHERE id = ?")
        .bind(userId, boundRepository, printerId).run();
      const body = await pull(call);
      assert.equal(body.printer, null);
      assert.equal(body.repository.id, repositoryId);
      const applied = await call("applied", { versionNumber: 1 });
      assert.equal(applied.status, 409);
      assert.equal((await applied.json()).code, "applied_version_conflict");
    }
  });

  it("looks up requested applied versions within the repository and retains the printer name in new history", async () => {
    const { repositoryId, printerId, call } = await fixture("applied");
    const latestId = await version(repositoryId, 2);
    await version("repo_other", 99);
    await db.prepare("UPDATE repositories SET latest_version_id = ? WHERE id = ?").bind(latestId, repositoryId).run();
    const missing = await call("applied", { versionNumber: 99 });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Repository version not found" });
    const applied = await call("applied", { versionNumber: 1 });
    assert.equal(applied.status, 200);
    const body = await applied.json();
    assert.equal(body.appliedVersion.version_number, 1);
    assert.equal(body.desired.versionNumber, 2);
    assert.equal(body.desiredChanged, true);
    const state = await db.prepare("SELECT applied_version_id, latest_version_id FROM printers WHERE id = ?").bind(printerId).first();
    assert.deepEqual(state, { applied_version_id: 1, latest_version_id: 2 });
    const installed = await call("applied", { files: files("installed from disk") });
    assert.equal(installed.status, 200);
    assert.equal((await installed.json()).appliedVersion.version_number, 3);
    const history = await db.prepare("SELECT message, source FROM repository_versions WHERE repository_id = ? AND version_number = 3")
      .bind(repositoryId).first();
    assert.deepEqual(history, { message: `Installed on ${printerId}`, source: "printer-apply" });
  });

  it("repairs legacy bindings only when exactly one owned candidate exists", async () => {
    const { repositoryId, printerId, call } = await fixture("legacy", { bound: false });
    const report = () => call("host-info", { hostInfo: { hostname: "sync-state.test" } });
    await printer(`${printerId}-foreign`, repositoryId, "user_2");
    assert.equal((await report()).status, 400);
    await printer(printerId, repositoryId);
    const repaired = await report();
    assert.equal(repaired.status, 200);
    await repaired.json();
    assert.equal((await db.prepare("SELECT printer_id FROM sync_tokens WHERE id = ?").bind(repositoryId).first()).printer_id, printerId);
    await db.prepare("UPDATE sync_tokens SET printer_id = NULL WHERE id = ?").bind(repositoryId).run();
    await printer(`${printerId}-second`, repositoryId);
    const ambiguous = await report();
    assert.equal(ambiguous.status, 400);
    assert.deepEqual(await ambiguous.json(), { error: "Printer-bound sync token required" });
    assert.equal((await db.prepare("SELECT printer_id FROM sync_tokens WHERE id = ?").bind(repositoryId).first()).printer_id, null);
  });
});
