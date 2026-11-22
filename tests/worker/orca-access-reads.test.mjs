import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  bootSharedWorker, db, dispatch, disposeSharedWorker, hashToken,
  SESSION_TOKEN, SECOND_SESSION_TOKEN, WORKER_ORIGIN,
} from "./helpers.mjs";

const browser = { cookie: `__Host-klippee_session=${SESSION_TOKEN}`, origin: WORKER_ORIGIN, "content-type": "application/json" };
const other = { ...browser, cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
const timestamp = "2026-01-01T00:00:00.000Z";
const bearer = token => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("Orca setup and connection read contracts", () => {
  before(bootSharedWorker);
  after(disposeSharedWorker);

  async function device(id, userId = "user_1", uploads = 0, createdAt = timestamp) {
    const token = `klorcadevice_${randomBytes(32).toString("base64url")}`;
    await db.prepare(`INSERT INTO orca_devices (id,user_id,token_hash,created_at,last_used_at,uploads_enabled) VALUES (?,?,?,?,?,?)`)
      .bind(id, userId, await hashToken(token), createdAt, timestamp, uploads).run();
    return token;
  }

  async function grant({ printerId = null, deviceId = null, scope = "setup", expiresAt = "2099-01-01" } = {}) {
    const id = randomUUID(), token = `klorca_${randomBytes(32).toString("base64url")}`;
    await db.prepare(`INSERT INTO orca_capture_grants (id,user_id,printer_id,device_id,scope,token_hash,expires_at)
      VALUES (?,'user_1',?,?,?,?,?)`).bind(id, printerId, deviceId, scope, await hashToken(token), expiresAt).run();
    return { id, token };
  }

  const context = token => dispatch("/api/orca/capture/context", { method: "POST", headers: bearer(token) });

  it("lists owned setups in date order, filters by the stored printer and downloads only owned snapshots", async () => {
    for (const [id, userId, printerId, date] of [
      ["access-bound", "user_1", "printer_1", "2026-01-01"],
      ["access-unbound", "user_1", null, "2026-02-01"],
      ["access-other", "user_2", null, "2026-03-01"],
    ]) {
      await db.prepare(`INSERT INTO orca_setups (id,user_id,printer_id,summary_json,snapshot_json,created_at) VALUES (?,?,?,?,?,?)`)
        .bind(id, userId, printerId, JSON.stringify({ id, title: id, printerId: "stale-summary-printer" }),
          JSON.stringify({ marker: `${id}-snapshot` }), date).run();
    }
    const listed = await dispatch("/api/orca/setups", { headers: browser });
    assert.deepEqual((await listed.json()).setups, [
      { id: "access-unbound", title: "access-unbound", printerId: null },
      { id: "access-bound", title: "access-bound", printerId: "printer_1" },
    ]);
    const filtered = await dispatch("/api/printers/printer_1/orca-setups", { headers: browser });
    assert.deepEqual((await filtered.json()).setups.map(row => row.id), ["access-bound"]);
    const foreign = await dispatch("/api/orca/setups", { headers: other });
    assert.deepEqual((await foreign.json()).setups.map(row => row.id), ["access-other"]);
    const downloaded = await dispatch("/api/orca/setups/access-unbound", { headers: browser });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-disposition"), /attachment; filename="klippee-orca-access-unbound.json"/);
    assert.deepEqual(await downloaded.json(), {
      setup: { id: "access-unbound", title: "access-unbound", printerId: null }, snapshot: { marker: "access-unbound-snapshot" },
    });
    for (const id of ["access-other", "missing-setup"]) {
      const response = await dispatch(`/api/orca/setups/${id}`, { headers: browser });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Setup not found" });
    }
  });

  it("uses nullable, owner-matched printer names and preserves grant expiry and revocation", async () => {
    await db.prepare(`INSERT INTO printers (id,user_id,name,created_at,updated_at)
      VALUES ('access-foreign-printer','user_2','Private foreign name',?,?)`).bind(timestamp, timestamp).run();
    for (const [printerId, printerName] of [["printer_1", "Bench printer"], [null, "your profile library"], ["access-foreign-printer", "your profile library"]]) {
      const code = await grant({ printerId, scope: "library" });
      const response = await context(code.token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { printerId, printerName, scope: "library", expiresAt: "2099-01-01" });
      await db.prepare("DELETE FROM orca_capture_grants WHERE id = ?").bind(code.id).run();
      assert.equal((await context(code.token)).status, 401);
    }
    const expired = await grant({ expiresAt: "2000-01-01" });
    assert.equal((await context(expired.token)).status, 401);
    for (const token of ["klorca_short", `klorca_${"z".repeat(43)}`]) assert.equal((await context(token)).status, 401);
  });

  it("requires a matching owner and enabled uploads for device-backed capture grants", async () => {
    await device("access-enabled", "user_1", 1);
    await device("access-disabled", "user_1", 0);
    await device("access-foreign", "user_2", 1);
    for (const [deviceId, status] of [["access-enabled", 200], ["access-disabled", 401], ["access-foreign", 401]]) {
      const code = await grant({ deviceId });
      assert.equal((await context(code.token)).status, status);
    }
    const code = await grant({ deviceId: "access-enabled" });
    await db.prepare("UPDATE orca_devices SET uploads_enabled = 0 WHERE id = 'access-enabled'").run();
    assert.equal((await context(code.token)).status, 401);
    await db.prepare("UPDATE orca_devices SET uploads_enabled = 1 WHERE id = 'access-enabled'").run();
    assert.equal((await context(code.token)).status, 200);
    await db.prepare("DELETE FROM orca_devices WHERE id = 'access-enabled'").run();
    assert.equal((await context(code.token)).status, 401);
  });

  it("lists devices without credentials and keeps upload permission distinct from device authentication", async () => {
    const token = await device("access-new-device", "user_1", 1, "2099-01-01");
    const disabled = await device("access-old-device", "user_1", 0, "2000-01-01");
    const listed = await dispatch("/api/orca/devices", { headers: browser });
    const { devices } = await listed.json();
    assert.equal(devices[0].id, "access-new-device");
    assert.deepEqual(devices.map(row => row.createdAt), devices.map(row => row.createdAt).sort().reverse());
    assert(devices.every(row => row.id !== "access-foreign"));
    assert.deepEqual(Object.keys(devices[0]).sort(), ["createdAt", "id", "lastUsedAt", "uploadsEnabled"]);
    assert.equal(devices[0].uploadsEnabled, true);
    assert.equal(devices.find(row => row.id === "access-old-device").uploadsEnabled, false);
    const mint = token => dispatch("/api/orca/device/upload-connection", { method: "POST", headers: bearer(token), body: "{}" });
    assert.equal((await mint(token)).status, 400);
    assert.equal((await mint(disabled)).status, 403);
    assert.equal((await mint(`klorcadevice_${"z".repeat(43)}`)).status, 401);
    const activity = await db.prepare("SELECT last_used_at FROM orca_devices WHERE id = 'access-new-device'").first();
    assert.notEqual(activity.last_used_at, timestamp);
    const foreign = await dispatch("/api/orca/devices", { headers: other });
    assert.deepEqual((await foreign.json()).devices.map(row => row.id), ["access-foreign"]);
  });
});
