import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  bootSharedWorker, db, dispatch, disposeSharedWorker,
  SESSION_TOKEN, SECOND_SESSION_TOKEN, STORAGE_LIMITS, WORKER_ORIGIN,
} from "./helpers.mjs";

const ownerHeaders = { cookie: `__Host-klippee_session=${SESSION_TOKEN}` };
const otherHeaders = { cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };

describe("Physical-printer read contracts", () => {
  before(async () => {
    await bootSharedWorker();
    const cases = [
      ["unbound", "user_1", null, 0, null, "2000-01-01"],
      ["unapplied", "user_1", "repo_1", 0, null, "2000-01-01"],
      ["missing-version", "user_1", "repo_1", 99, null, "2000-01-01"],
      ["applied", "user_1", "repo_1", 1, "2026-11-01", "2090-01-01"],
      ["legacy-applied", "user_1", "repo_1", 1, null, "2000-01-01"],
      ["foreign", "user_2", "repo_other", 0, null, "2099-01-01"],
    ];
    await db.batch(cases.map(([id, userId, repositoryId, appliedVersion, appliedAt, updatedAt]) =>
      db.prepare(`INSERT INTO printers
        (id,user_id,name,repository_id,applied_version_id,applied_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(`read-${id}`, userId, `Read ${id}`, repositoryId, appliedVersion, appliedAt,
        "2000-01-01", updatedAt)));
    await db.prepare(`UPDATE printers SET variable_values_json = ?, host_info_json = ?, host_info_updated_at = ?
      WHERE id = 'read-applied'`).bind(JSON.stringify({ bed_temp: 60, enabled: true, nullable: null, api_token: "host-only" }),
      JSON.stringify({ hostname: "printer.test" }), "2026-11-01").run();
  });
  after(disposeSharedWorker);

  async function get(path, headers = ownerHeaders) {
    const response = await dispatch(path, { headers });
    assert.equal(response.status, 200);
    return response.json();
  }

  async function save(printer, headers = ownerHeaders) {
    return dispatch("/api/printers", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", origin: WORKER_ORIGIN },
      body: JSON.stringify({ printer }),
    });
  }

  it("lists only owned printers in update order with stable fields and scalar values", async () => {
    const { printers } = await get("/api/printers");
    assert.equal(printers.length, 6);
    assert.equal(printers[0].id, "read-applied");
    assert.deepEqual(printers.map(row => row.updatedAt), printers.map(row => row.updatedAt).sort().reverse());
    assert(printers.every(row => row.id !== "read-foreign"));
    assert.deepEqual(Object.keys(printers[0]).sort(), [
      "appliedAt", "appliedVersionId", "createdAt", "definition", "description", "hostInfo", "hostInfoUpdatedAt",
      "id", "latestVersionId", "make", "model", "name", "packageIds", "repositoryId", "source", "updatedAt", "variableValues",
    ]);
    assert.deepEqual(printers[0].variableValues, { bed_temp: 60, enabled: true, nullable: null });
    assert.deepEqual(printers[0].hostInfo, { hostname: "printer.test" });
    assert.equal(printers[0].appliedVersionId, 1);
    const other = await get("/api/printers", otherHeaders);
    assert.deepEqual(other.printers.map(row => row.id), ["read-foreign"]);
  });

  it("keeps null candidates for unbound, unapplied and missing applied versions", async () => {
    for (const id of ["unbound", "unapplied", "missing-version"]) {
      assert.deepEqual(await get(`/api/printers/read-${id}/publication-candidate`), { candidate: null });
    }
    for (const [id, appliedAt] of [["applied", "2026-11-01"], ["legacy-applied", null]]) {
      const { candidate } = await get(`/api/printers/read-${id}/publication-candidate`);
      assert.equal(candidate.appliedAt, appliedAt);
      assert.equal(candidate.repositoryId, "repo_1");
      assert.equal(candidate.versionId, "version_1");
      assert.equal(candidate.versionNumber, 1);
      assert(Array.isArray(candidate.files));
    }
  });

  it("does not reveal foreign or missing printers through candidate or variable reads", async () => {
    for (const id of ["read-foreign", "missing-printer"]) {
      const candidate = await dispatch(`/api/printers/${id}/publication-candidate`, { headers: ownerHeaders });
      assert.equal(candidate.status, 404);
      assert.deepEqual(await candidate.json(), { error: "Printer not found" });
      const patch = await dispatch(`/api/printers/${id}/variables/bed_temp`, {
        method: "PATCH",
        headers: { ...ownerHeaders, "content-type": "application/json", origin: WORKER_ORIGIN },
        body: JSON.stringify({ value: 70 }),
      });
      assert.equal(patch.status, 404);
      assert.deepEqual(await patch.json(), { error: "Printer not found" });
    }
  });

  it("preserves creation time and saved values across metadata edits and reads the result immediately", async () => {
    const response = await save({ id: "read-applied", name: "Renamed printer", repositoryId: "repo_1", createdAt: "2099-01-01" });
    assert.equal(response.status, 200);
    const { printer } = await response.json();
    assert.equal(printer.createdAt, "2000-01-01");
    assert.equal(printer.name, "Renamed printer");
    assert.deepEqual(printer.variableValues, { bed_temp: 60, enabled: true, nullable: null });
    const listed = (await get("/api/printers")).printers.find(row => row.id === printer.id);
    assert.deepEqual(listed, printer);
  });

  it("scopes quota counts to the owner and allows existing-printer updates at the limit", async () => {
    const { count } = await db.prepare("SELECT COUNT(*) AS count FROM printers WHERE user_id = 'user_1'").first();
    await db.batch(Array.from({ length: STORAGE_LIMITS.printers - count }, (_, index) => db.prepare(`INSERT INTO printers
      (id,user_id,name,created_at,updated_at) VALUES (?,'user_1',?,'2000-01-01','2000-01-01')`)
      .bind(`read-quota-${index}`, `Quota ${index}`)));
    const blocked = await save({ id: "read-over-quota", name: "Over quota" });
    assert.equal(blocked.status, 409);
    const updated = await save({ id: "read-unbound", name: "Updated at quota" });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).printer.name, "Updated at quota");
    const other = await save({ id: "read-other-new", name: "Other owner below quota" }, otherHeaders);
    assert.equal(other.status, 201);
  });
});
