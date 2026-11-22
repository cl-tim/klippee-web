import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  bootSharedWorker, db, dispatch, disposeSharedWorker, hashToken,
  SESSION_TOKEN, SECOND_SESSION_TOKEN, STORAGE_LIMITS, WORKER_ORIGIN,
} from "./helpers.mjs";

const ownerHeaders = { cookie: `__Host-klippee_session=${SESSION_TOKEN}` };
const otherHeaders = { cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
const timestamp = "2026-01-01T00:00:00.000Z";

describe("Sync-token read contracts", () => {
  before(bootSharedWorker);
  after(disposeSharedWorker);

  async function insertToken(id, {
    repositoryId = "repo_1", userId = "user_1", printerId = null,
    scopes = ["repo:read", "repo:write"], name = id, expiresAt = null, createdAt = timestamp,
  } = {}) {
    const token = `klp_read_${id}`;
    await db.prepare(`INSERT INTO sync_tokens
      (id,user_id,repository_id,printer_id,name,token_hash,token_prefix,scopes_json,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, userId, repositoryId, printerId, name,
      await hashToken(token), token.slice(0, 12), JSON.stringify(scopes), expiresAt, createdAt).run();
    return token;
  }

  function create(repositoryId, body, headers = ownerHeaders) {
    return dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      method: "POST", headers: { ...headers, origin: WORKER_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function status(token, repositoryId = "repo_1") {
    return dispatch(`/api/sync/repos/${repositoryId}/status.txt`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it("lists only the owner's repository tokens in creation order without credentials", async () => {
    await insertToken("listed-new", { createdAt: "2099-01-01", printerId: "printer_1", scopes: ["repo:read"] });
    await insertToken("listed-foreign", { repositoryId: "repo_other", userId: "user_2" });
    const response = await dispatch("/api/repos/repo_1/sync-tokens", { headers: ownerHeaders });
    assert.equal(response.status, 200);
    const { tokens } = await response.json();
    assert.equal(tokens.length, 3);
    assert.equal(tokens[0].id, "listed-new");
    assert.deepEqual(tokens.map(row => row.created_at), tokens.map(row => row.created_at).sort().reverse());
    assert.deepEqual(Object.keys(tokens[0]).sort(), [
      "created_at", "expires_at", "id", "last_used_at", "name", "printer_id", "scopes", "token_prefix",
    ]);
    assert.deepEqual(tokens[0].scopes, ["repo:read"]);
    assert.equal(tokens[0].printer_id, "printer_1");
    assert.equal(tokens[0].expires_at, null);
    assert.equal(tokens[0].last_used_at, null);
    assert.equal(tokens.find(row => row.id === "sync_token_repo").printer_id, null);
    const foreign = await dispatch("/api/repos/repo_other/sync-tokens", { headers: otherHeaders });
    assert.deepEqual((await foreign.json()).tokens.map(row => row.id), ["listed-foreign"]);
    for (const repositoryId of ["repo_other", "missing-repo"]) {
      const denied = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, { headers: ownerHeaders });
      assert.equal(denied.status, 404);
      assert.deepEqual(await denied.json(), { error: "Repository not found" });
      assert.equal((await create(repositoryId, {})).status, 404);
    }
  });

  it("checks owned printer bindings and immediately exposes a newly created binding and token", async () => {
    await db.prepare(`INSERT INTO printers (id,user_id,name,repository_id,created_at,updated_at)
      VALUES ('token-unbound','user_1','Unbound',NULL,?,?),
             ('token-foreign','user_2','Foreign','repo_other',?,?),
             ('token-other-repo','user_1','Other repository','repo_other',?,?)`)
      .bind(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp).run();
    for (const printerId of ["token-foreign", "token-other-repo", "missing-printer"]) {
      const denied = await create("repo_1", { printerId });
      assert.equal(denied.status, 404);
      assert.deepEqual(await denied.json(), { error: "Printer not found for this repository" });
    }
    for (const printerId of ["token-unbound", "printer_1"]) {
      const created = await create("repo_1", { printerId, scopes: ["repo:read", "invalid", "repo:read"] });
      assert.equal(created.status, 201);
      const { token, tokenRecord } = await created.json();
      assert.equal(tokenRecord.printer_id, printerId);
      assert.deepEqual(tokenRecord.scopes, ["repo:read"]);
      assert.equal((await db.prepare("SELECT repository_id FROM printers WHERE id = ?").bind(printerId).first()).repository_id, "repo_1");
      const pull = await dispatch("/api/sync/repos/repo_1/pull", { headers: { authorization: `Bearer ${token}` } });
      assert.equal(pull.status, 200);
      const body = await pull.json();
      assert.equal(body.repository.id, "repo_1");
      assert.equal(body.repository.name, "test-printer");
      assert.equal(body.printer.id, printerId);
      assert.equal(body.version.version_number, 1);
    }
  });

  it("rejects missing, unknown, expired, wrong-repository and insufficient-scope tokens without activity writes", async () => {
    const expired = await insertToken("expired", { expiresAt: "2000-01-01" });
    const future = await insertToken("future", { expiresAt: "2099-01-01" });
    const writeOnly = await insertToken("write-only", { scopes: ["repo:write"] });
    const cases = [
      [null, "repo_1", 401, "Sync token required"],
      ["klp_missing", "repo_1", 401, "Invalid sync token"],
      [expired, "repo_1", 401, "Invalid sync token"],
      [future, "repo_other", 401, "Invalid sync token"],
      [future, "missing-repo", 401, "Invalid sync token"],
      [writeOnly, "repo_1", 403, "Sync token scope denied"],
    ];
    for (const [token, repositoryId, code, error] of cases) {
      const response = await status(token, repositoryId);
      assert.equal(response.status, code);
      assert.deepEqual(await response.json(), { error });
    }
    const activity = (await db.prepare("SELECT last_used_at FROM sync_tokens WHERE id IN ('expired','future','write-only')").all()).results;
    assert(activity.every(row => row.last_used_at === null));
    const allowed = await status(future);
    assert.equal(allowed.status, 200);
    await allowed.text();
    assert.notEqual((await db.prepare("SELECT last_used_at FROM sync_tokens WHERE id = 'future'").first()).last_used_at, null);
  });

  it("retains both explicit and legacy desktop-client restrictions", async () => {
    const tokens = [
      await insertToken("desktop-scope", { scopes: ["repo:read", "repo:write", "client:desktop"], printerId: "printer_1" }),
      await insertToken("desktop-name", { name: "Legacy DESKTOP SYNC TOKEN", printerId: "printer_1" }),
    ];
    for (const token of tokens) {
      const applied = await dispatch("/api/sync/repos/repo_1/applied", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ versionNumber: 1 }),
      });
      assert.equal(applied.status, 403);
      assert.deepEqual(await applied.json(), { error: "Desktop clients cannot mark a version as installed on the printer" });
    }
  });

  it("counts quotas per owner and repository, including an initially empty repository", async () => {
    await db.prepare(`INSERT INTO repositories (id,user_id,name,title,created_at,updated_at)
      VALUES ('token-quota','user_1','quota','Quota',?,?)`).bind(timestamp, timestamp).run();
    const created = await create("token-quota", {});
    assert.equal(created.status, 201);
    await created.json();
    // Neither another owner's row nor this owner's rows in repo_1 consume this quota.
    await insertToken("quota-foreign", { repositoryId: "token-quota", userId: "user_2" });
    for (let index = 0; index < STORAGE_LIMITS.syncTokens - 2; index++) {
      await insertToken(`quota-${index}`, { repositoryId: "token-quota" });
    }
    const last = await create("token-quota", {});
    assert.equal(last.status, 201);
    await last.json();
    const denied = await create("token-quota", {});
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).resource, "sync-tokens");
    const total = await db.prepare("SELECT COUNT(*) AS count FROM sync_tokens WHERE repository_id = 'token-quota' AND user_id = 'user_1'").first();
    assert.equal(total.count, STORAGE_LIMITS.syncTokens);
    const listed = await dispatch("/api/repos/token-quota/sync-tokens", { headers: ownerHeaders });
    const { tokens } = await listed.json();
    assert.equal(tokens.length, STORAGE_LIMITS.syncTokens);
    assert(tokens.every(row => row.id !== "quota-foreign"));
  });

  it("revokes a token immediately while foreign deletion attempts leave it usable", async () => {
    const token = await insertToken("revoked");
    const remove = headers => dispatch("/api/repos/repo_1/sync-tokens/revoked", {
      method: "DELETE", headers: { ...headers, origin: WORKER_ORIGIN },
    });
    assert.equal((await remove(otherHeaders)).status, 404);
    const allowed = await status(token);
    assert.equal(allowed.status, 200);
    await allowed.text();
    assert.equal((await remove(ownerHeaders)).status, 200);
    const denied = await status(token);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "Invalid sync token" });
    const listed = await dispatch("/api/repos/repo_1/sync-tokens", { headers: ownerHeaders });
    assert(!(await listed.json()).tokens.some(row => row.id === "revoked"));
  });
});
