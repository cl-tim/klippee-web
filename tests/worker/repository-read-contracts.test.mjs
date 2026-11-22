import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  bootSharedWorker, db, dispatch, disposeSharedWorker,
  SESSION_TOKEN, SECOND_SESSION_TOKEN, WORKER_ORIGIN,
} from "./helpers.mjs";

const ownerHeaders = { cookie: `__Host-klippee_session=${SESSION_TOKEN}` };
const otherHeaders = { cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
const summaryKeys = ["created_at", "id", "latest_version_id", "name", "title", "updated_at"];

describe("Repository read contracts", () => {
  before(async () => {
    await bootSharedWorker();
    await db.batch([
      db.prepare(`INSERT INTO repositories (id,user_id,name,title,created_at,updated_at)
        VALUES ('read-empty','user_1','read-empty','Empty history','2000-01-01','2000-01-01')`),
      db.prepare(`UPDATE repositories SET pending_files_json =
        (SELECT files_json FROM repository_versions WHERE id = 'version_1'),
        pending_updated_at = '2026-11-01' WHERE id = 'repo_1'`),
      // Legacy data can bind printers from different owners to one repository.
      // A newer foreign printer must never win the owner's bound-printer read.
      db.prepare(`INSERT INTO printers (id,user_id,name,repository_id,created_at,updated_at)
        VALUES ('foreign-printer','user_2','Foreign printer','repo_1','2099-01-01','2099-01-01')`),
    ]);
  });
  after(disposeSharedWorker);

  async function get(path, headers = ownerHeaders) {
    const response = await dispatch(path, { headers });
    assert.equal(response.status, 200);
    return response.json();
  }

  it("lists only owned repositories in update order with the existing summary fields", async () => {
    const { repositories } = await get("/api/repos");
    assert.deepEqual(repositories.map(repo => repo.id), ["repo_1", "read-empty"]);
    for (const repo of repositories) assert.deepEqual(Object.keys(repo).sort(), summaryKeys);
    assert.equal(repositories[1].latest_version_id, null);
    const other = await get("/api/repos", otherHeaders);
    assert.deepEqual(other.repositories.map(repo => repo.id), ["repo_other"]);
  });

  it("does not reveal another owner's or a missing repository through history reads", async () => {
    for (const id of ["repo_other", "missing-repository"]) {
      for (const suffix of ["versions", "sync-status", "diff?from=1&to=1"]) {
        const response = await dispatch(`/api/repos/${id}/${suffix}`, { headers: ownerHeaders });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "Repository not found" });
      }
    }
  });

  it("keeps null latest/printer values and empty history, then appends version one", async () => {
    const history = await get("/api/repos/read-empty/versions");
    assert.deepEqual(history.versions, []);
    assert.equal(history.desired, null);
    const status = await get("/api/repos/read-empty/sync-status");
    assert.equal(status.latestVersion, null);
    assert.equal(status.printer, null);
    const missing = await dispatch("/api/repos/read-empty/diff?from=1&to=1", { headers: ownerHeaders });
    assert.equal(missing.status, 404);

    const created = await dispatch("/api/repos/read-empty/versions", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json", origin: WORKER_ORIGIN },
      body: JSON.stringify({ files: [{ path: "printer.cfg", content: "[printer]\nkinematics: corexy\n", public: false, role: "printer" }] }),
    });
    assert.equal(created.status, 201);
    const { version } = await created.json();
    assert.equal(version.version_number, 1);
    const updated = await get("/api/repos/read-empty/versions");
    assert.deepEqual(updated.versions.map(row => row.version_number), [1]);
    assert.equal(updated.versions[0].previous_version_id, null);
  });

  it("keeps repository/latest projections and selects only the owner's bound printer", async () => {
    const status = await get("/api/repos/repo_1/sync-status");
    assert.deepEqual(Object.keys(status.repository).sort(), summaryKeys);
    assert.deepEqual(Object.keys(status.latestVersion).sort(), ["created_at", "id", "message", "source", "version_number"]);
    assert.equal(status.latestVersion.version_number, 1);
    assert.equal(status.printer.id, "printer_1");
    assert.equal(Object.hasOwn(status.printer, "variableValues"), false);
    const history = await get("/api/repos/repo_1/versions");
    assert.deepEqual(history.versions.map(row => row.version_number), [1]);
    assert(history.versions[0].files.some(file => file.path === "printer.cfg" && file.content));
    assert.equal(Object.hasOwn(history.versions[0], "repository_id"), false);
  });
});
