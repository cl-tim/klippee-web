import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { SESSION_TOKEN, SECOND_SESSION_TOKEN, WORKER_ORIGIN, bootSharedWorker, db, dispatch, disposeSharedWorker } from "./helpers.mjs";
const browser = { cookie: `__Host-klippee_session=${SESSION_TOKEN}`, origin: WORKER_ORIGIN, "content-type": "application/json" };
const other = { ...browser, cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
function library() {
  const nodes = {}, selections = [], profiles = [];
  for (const kind of ["machine", "process", "filament"]) {
    const name = `QIDI ${kind}`, node = `${kind}:${name}`;
    const saved = { inherits: "", value: "saved", print_host: "private", api_key: "credential" };
    nodes[node] = { kind, name, parent: null, saved, source_json: null };
    selections.push({ node, slot: kind === "filament" ? 0 : null, dirty: true, effective: { ...saved, value: "edited" }, changes: {} });
    profiles.push({ node, custom: true, enabled: true });
  }
  const current = { format: "klippee-orca-setup/v1", nodes: structuredClone(nodes), selections };
  nodes["machine:QIDI 0.2"] = { kind: "machine", name: "QIDI 0.2", parent: "machine:QIDI machine", saved: { inherits: "QIDI machine", nozzle_diameter: "0.2" }, source_json: null };
  profiles.push({ node: "machine:QIDI 0.2", custom: false, enabled: true });
  return { format: "klippee-orca-library/v1", nodes, profiles, current };
}
async function grant() {
  const response = await dispatch("/api/orca/connection", { method: "POST", headers: browser });
  assert.equal(response.status, 201);
  const result = await response.json();
  return { ...result, headers: { authorization: `Bearer ${new URL(result.code).hash.slice(1)}`, "content-type": "application/json" } };
}
function save(connection, capture = library()) {
  return dispatch("/api/orca/library", { method: "POST", headers: connection.headers, body: JSON.stringify({ hostVersion: "2.5.0-alpha", library: capture }) });
}
async function get() { return (await (await dispatch("/api/orca/library", { headers: browser })).json()).library; }

describe("worker API: account-wide Orca library", () => {
  before(bootSharedWorker); after(disposeSharedWorker);
  it("adds nozzle, material and layer tags to existing library imports without changing exports", async () => {
    const code = await grant(), snapshot = library();
    snapshot.nodes["machine:QIDI 0.2"].saved.printer_model = "QIDI Plus 4";
    for (const [kind, name, saved] of [
      ["process", "Fine quality", { inherits: "", layer_height: "0.08", compatible_printers: '"QIDI 0.2"' }],
      ["filament", "Fine PLA", { inherits: "", filament_type: "PLA", compatible_printers: '"QIDI 0.2"' }],
    ]) {
      const id = `${kind}:${name}`;
      snapshot.nodes[id] = { kind, name, parent: null, saved, source_json: null };
      snapshot.profiles.push({ node: id, custom: true, enabled: true });
    }
    assert.equal((await save(code, snapshot)).status, 201);
    const imported = await get();
    assert.deepEqual(imported.profiles.find(p => p.name === "Fine quality").tags, {
      nozzleSizes: ["0.2"], nozzleScope: "specific", materials: [], layerHeights: ["0.08"], printerModels: ["QIDI Plus 4"], hasCompatibilityRule: false,
    });
    assert.deepEqual(imported.profiles.find(p => p.name === "Fine PLA").tags.materials, ["PLA"]);
    const exported = await (await dispatch("/api/orca/library/profile-export?profileId=process%3AFine%20quality", { headers: browser })).json();
    assert.equal(exported.snapshot.selections[0].node, "process:Fine quality");
    assert.equal(exported.snapshot.nodes["process:Fine quality"].saved.compatible_printers, '"QIDI 0.2"');
    await dispatch(`/api/orca/connections/${code.id}`, { method: "DELETE", headers: browser });
  });
  it("imports all roots atomically, sanitizes ancestors and current edits, and rejects cross-account access", async () => {
    assert.equal((await dispatch("/api/orca/connection", { method: "POST", headers: { ...browser, origin: "https://elsewhere.test" } })).status, 403);
    const code = await grant();
    const context = await (await dispatch("/api/orca/capture/context", { method: "POST", headers: code.headers })).json();
    assert.equal(context.printerId, null); assert.equal(context.scope, "library");
    assert.equal((await dispatch("/api/orca/capture", { method: "POST", headers: code.headers, body: "{}" })).status, 400);
    for (const response of await Promise.all([save(code), save(code)])) assert.ok([200, 201].includes(response.status));
    const imported = await get(); assert.equal(imported.id, code.id); assert.equal(imported.profiles.length, 4);
    assert.equal(imported.profiles.find(p => p.name === "QIDI 0.2").nozzle, "0.2");
    const exported = await dispatch("/api/orca/library/export", { headers: browser });
    const result = await exported.json();
    assert.equal(result.current.selections[0].changes.value, "edited");
    assert.equal(JSON.stringify(result).includes("credential"), false);
    assert.equal((await dispatch("/api/orca/library/export", { headers: other })).status, 404);
    assert.equal((await dispatch("/api/orca/library", { headers: code.headers })).status, 401);
    assert.equal((await dispatch("/api/orca/library", { headers: other })).status, 200);
    assert.equal((await (await dispatch("/api/orca/library", { headers: other })).json()).library, null);
    await dispatch(`/api/orca/connections/${code.id}`, { method: "DELETE", headers: browser });
  });
  it("limits native browsing to expiring, revocable read-only grants and rejects stale library selections", async () => {
    const imported = await grant(); await save(imported);
    const response = await dispatch("/api/orca/restore-connection", { method: "POST", headers: browser });
    assert.equal(response.status, 201);
    const connection = await response.json();
    const headers = { authorization: `Bearer ${new URL(connection.code).hash.slice(1)}`, "content-type": "application/json" };
    const listed = await dispatch("/api/orca/restore/library", { method: "POST", headers, body: "{}" });
    assert.equal(listed.status, 200);
    const listing = await listed.json(); assert.equal(listing.library.id, imported.id); assert.equal(listing.library.profiles.length, 4);
    const body = JSON.stringify({ profileId: "machine:QIDI 0.2", importId: imported.id });
    const downloaded = await dispatch("/api/orca/restore/profile", { method: "POST", headers, body });
    assert.equal(downloaded.status, 200);
    assert.equal((await downloaded.json()).snapshot.selections[0].node, "machine:QIDI 0.2");
    assert.equal((await dispatch("/api/orca/library", { method: "POST", headers, body: "{}" })).status, 401);
    assert.equal((await dispatch("/api/orca/capture", { method: "POST", headers, body: "{}" })).status, 400);
    assert.equal((await dispatch("/api/orca/library/export", { headers })).status, 401);
    assert.equal((await dispatch("/api/orca/restore/library", { method: "POST", headers: browser, body: "{}" })).status, 401);
    assert.equal((await dispatch("/api/orca/restore/library", { method: "POST", headers: imported.headers, body: "{}" })).status, 401);
    assert.equal((await dispatch("/api/orca/restore-connection", { method: "POST", headers: { ...browser, origin: "https://elsewhere.test" } })).status, 403);
    const next = await grant(); await save(next);
    assert.equal((await dispatch("/api/orca/restore/profile", { method: "POST", headers, body })).status, 409);
    await db.prepare("UPDATE orca_capture_grants SET expires_at = '2000-01-01' WHERE id = ?").bind(connection.id).run();
    assert.equal((await dispatch("/api/orca/restore/library", { method: "POST", headers, body: "{}" })).status, 401);
    await dispatch(`/api/orca/connections/${connection.id}`, { method: "DELETE", headers: browser });
    assert.equal((await dispatch("/api/orca/restore/profile", { method: "POST", headers, body })).status, 401);
    for (const code of [imported, next]) await dispatch(`/api/orca/connections/${code.id}`, { method: "DELETE", headers: browser });
  });
  it("pairs once, survives code expiry, stays read-only, and can be revoked from either side", async () => {
    const imported = await grant(); await save(imported);
    const pair = async () => {
      const response = await dispatch("/api/orca/pair-connection", { method: "POST", headers: browser });
      assert.equal(response.status, 201);
      const code = await response.json();
      return { ...code, headers: { authorization: `Bearer ${new URL(code.code).hash.slice(1)}`, "content-type": "application/json" } };
    };
    const code = await pair();
    const token = "klorcadevice_" + "D".repeat(43), headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const pairing = () => dispatch("/api/orca/restore/pair", { method: "POST", headers: code.headers, body: JSON.stringify({ token }) });
    assert.equal((await pairing()).status, 200);
    assert.equal((await pairing()).status, 200);
    assert.equal((await dispatch("/api/orca/restore/pair", { method: "POST", headers: code.headers, body: JSON.stringify({ token: "klorcadevice_" + "E".repeat(43) }) })).status, 409);
    await db.prepare("UPDATE orca_capture_grants SET expires_at = '2000-01-01' WHERE id = ?").bind(code.id).run();
    const read = () => dispatch("/api/orca/restore/library", { method: "POST", headers, body: "{}" });
    const response = await read(); assert.equal(response.status, 200); assert.equal((await response.json()).expiresAt, null);
    assert.equal((await dispatch("/api/orca/restore/profile", { method: "POST", headers, body: JSON.stringify({ profileId: "machine:QIDI 0.2", importId: imported.id }) })).status, 200);
    for (const path of ["/api/orca/library", "/api/orca/capture", "/api/orca/restore/pair"]) assert.ok([400, 401].includes((await dispatch(path, { method: "POST", headers, body: "{}" })).status));
    assert.equal((await dispatch("/api/orca/devices", { headers })).status, 401);
    const devices = await (await dispatch("/api/orca/devices", { headers: browser })).json();
    assert.equal(devices.devices.length, 1); assert.equal(devices.devices[0].id, code.id); assert.equal(JSON.stringify(devices).includes("token"), false);
    assert.equal((await (await dispatch("/api/orca/devices", { headers: other })).json()).devices.length, 0);
    await dispatch(`/api/orca/devices/${code.id}`, { method: "DELETE", headers: other });
    assert.equal((await read()).status, 200);
    await dispatch(`/api/orca/devices/${code.id}`, { method: "DELETE", headers: browser });
    assert.equal((await read()).status, 401);
    assert.equal((await pairing()).status, 401);
    const next = await pair();
    await dispatch("/api/orca/restore/pair", { method: "POST", headers: next.headers, body: JSON.stringify({ token }) });
    assert.equal((await read()).status, 200);
    assert.equal((await dispatch("/api/orca/restore/disconnect", { method: "POST", headers, body: "{}" })).status, 200);
    assert.equal((await read()).status, 401);
    assert.equal((await dispatch("/api/orca/restore/pair", { method: "POST", headers: next.headers, body: JSON.stringify({ token }) })).status, 401);
    const cancelled = await pair();
    await dispatch("/api/orca/restore/pair", { method: "POST", headers: cancelled.headers, body: JSON.stringify({ token }) });
    await dispatch(`/api/orca/connections/${cancelled.id}`, { method: "DELETE", headers: browser });
    assert.equal((await read()).status, 401);
    assert.equal((await dispatch("/api/orca/restore/pair", { method: "POST", headers: browser, body: JSON.stringify({ token }) })).status, 401);
    await dispatch(`/api/orca/connections/${imported.id}`, { method: "DELETE", headers: browser });
  });
  it("uses an explicitly enabled device for retry-safe imports and four-slot setup saves, and cancels reviews on revocation", async () => {
    const paired = await (await dispatch("/api/orca/pair-connection", { method: "POST", headers: browser })).json();
    const pairHeaders = { authorization: `Bearer ${new URL(paired.code).hash.slice(1)}`, "content-type": "application/json" };
    const device = "klorcadevice_" + "U".repeat(43), headers = { authorization: `Bearer ${device}`, "content-type": "application/json" };
    assert.equal((await dispatch("/api/orca/restore/pair", { method: "POST", headers: pairHeaders, body: JSON.stringify({ token: device }) })).status, 200);
    const operation = (scope) => ({ id: crypto.randomUUID(), token: "klorca_" + crypto.randomUUID().replaceAll("-", "").padEnd(43, "x"), scope });
    const mint = (body) => dispatch("/api/orca/device/upload-connection", { method: "POST", headers, body: JSON.stringify(body) });
    const permission = (uploadsEnabled, actor = browser) => dispatch(`/api/orca/devices/${paired.id}`, { method: "PUT", headers: actor, body: JSON.stringify({ uploadsEnabled }) });
    const imported = operation("library");
    assert.equal((await mint(imported)).status, 403);
    assert.equal((await permission(true, other)).status, 404);
    assert.equal((await permission(true, headers)).status, 403);
    assert.equal((await permission(true, { ...browser, origin: "https://elsewhere.test" })).status, 403);
    assert.equal((await permission(true)).status, 200);
    assert.equal((await mint({ ...imported, scope: "delete" })).status, 400);
    for (let retry = 0; retry < 2; retry++) assert.equal((await mint(imported)).status, 200);
    const uploadHeaders = (op) => ({ authorization: `Bearer ${op.token}`, "content-type": "application/json" });
    for (let retry = 0; retry < 2; retry++) assert.ok([200, 201].includes((await save({ headers: uploadHeaders(imported) })).status));
    const capture = library().current;
    for (let slot = 1; slot < 4; slot++) capture.selections.push({ ...capture.selections[2], slot });
    const setup = operation("setup"); assert.equal((await mint(setup)).status, 200);
    const saveSetup = (op) => dispatch("/api/orca/capture", { method: "POST", headers: uploadHeaders(op), body: JSON.stringify({ title: "Paired four-slot setup", hostVersion: "2.5.0-alpha", hostBuild: "test", snapshot: capture }) });
    const first = await saveSetup(setup); assert.equal(first.status, 201);
    const summary = (await first.json()).setup; assert.equal(summary.printerId, null); assert.equal(summary.selections.filter(s => s.kind === "filament").length, 4);
    assert.equal((await saveSetup(setup)).status, 200);
    const next = operation("setup"); assert.equal((await mint(next)).status, 200);
    assert.equal((await saveSetup(next)).status, 201);
    const completed = [setup.id, next.id];
    for (let index = 0; index < 6; index++) {
      const additional = operation("setup"); assert.equal((await mint(additional)).status, 200);
      assert.equal((await saveSetup(additional)).status, 201); completed.push(additional.id);
    }
    const pending = operation("setup"); assert.equal((await mint(pending)).status, 200);
    assert.equal((await permission(false)).status, 200);
    assert.equal((await saveSetup(pending)).status, 401);
    assert.equal((await dispatch("/api/orca/restore/library", { method: "POST", headers, body: "{}" })).status, 200);
    assert.equal((await mint(operation("setup"))).status, 403);
    assert.equal((await permission(true)).status, 200);
    const revoked = operation("setup"); assert.equal((await mint(revoked)).status, 200);
    await dispatch(`/api/orca/devices/${paired.id}`, { method: "DELETE", headers: browser });
    assert.equal((await saveSetup(revoked)).status, 401);
    assert.equal((await mint(revoked)).status, 401);
    for (const id of completed) await dispatch(`/api/orca/setups/${id}`, { method: "DELETE", headers: browser });
  });
  it("exports only an owned library profile and its complete saved ancestry", async () => {
    const code = await grant(); await save(code);
    const path = "/api/orca/library/profile-export?profileId=" + encodeURIComponent("machine:QIDI 0.2");
    const response = await dispatch(path, { headers: browser });
    assert.equal(response.status, 200);
    const { snapshot } = await response.json();
    assert.equal(snapshot.format, "klippee-orca-profile/v1");
    assert.deepEqual(Object.keys(snapshot.nodes), ["machine:QIDI 0.2", "machine:QIDI machine"]);
    assert.equal(snapshot.selections.length, 1);
    assert.equal(snapshot.selections[0].slot, null);
    assert.equal(snapshot.selections[0].dirty, false);
    assert.deepEqual(snapshot.selections[0].effective, snapshot.nodes["machine:QIDI 0.2"].saved);
    assert.equal(JSON.stringify(snapshot).includes("credential"), false);
    assert.equal((await dispatch(path, { headers: other })).status, 404);
    assert.equal((await dispatch(path)).status, 401);
    assert.equal((await dispatch("/api/orca/library/profile-export?profileId=process:missing", { headers: browser })).status, 404);
    await dispatch(`/api/orca/connections/${code.id}`, { method: "DELETE", headers: browser });
  });
  it("supports several nozzle profiles for one device and one profile for several devices; links survive reimport", async () => {
    const first = await grant(); await save(first);
    await db.prepare("INSERT INTO printers (id, user_id, name, created_at, updated_at) VALUES ('library-device', 'user_1', 'Second QIDI', '2026-01-01', '2026-01-01')").run();
    for (const [profileId, printerId] of [["machine:QIDI machine", "printer_1"], ["machine:QIDI 0.2", "printer_1"], ["machine:QIDI 0.2", "library-device"]]) {
      assert.equal((await dispatch("/api/orca/profile-printers", { method: "PUT", headers: browser, body: JSON.stringify({ profileId, printerId, linked: true }) })).status, 200);
    }
    assert.equal((await dispatch("/api/orca/profile-printers", { method: "PUT", headers: other, body: JSON.stringify({ profileId: "machine:QIDI 0.2", printerId: "printer_1", linked: true }) })).status, 404);
    const second = await grant(); await save(second);
    assert.deepEqual((await get()).profiles.find(p => p.id === "machine:QIDI 0.2").printerIds.sort(), ["library-device", "printer_1"]);
    await save(first); assert.equal((await get()).id, second.id, "replaying an older code must not replace a later import");
    await db.prepare("INSERT INTO orca_setups (id, user_id, printer_id, summary_json, snapshot_json, created_at) VALUES ('device-setup', 'user_1', 'library-device', ?, ?, '2026-01-01')")
      .bind(JSON.stringify({ printerId: "library-device", title: "Existing device setup" }), JSON.stringify(library().current)).run();
    await db.prepare("DELETE FROM printers WHERE id = 'library-device'").run();
    assert.deepEqual((await get()).profiles.find(p => p.id === "machine:QIDI 0.2").printerIds, ["printer_1"]);
    const retained = await (await dispatch("/api/orca/setups/device-setup", { headers: browser })).json();
    assert.equal(retained.setup.printerId, null); assert.equal(retained.snapshot.selections.length, 3);
    await db.prepare("DELETE FROM orca_setups WHERE id = 'device-setup'").run();
    for (const code of [first, second]) await dispatch(`/api/orca/connections/${code.id}`, { method: "DELETE", headers: browser });
  });
  it("rejects unrelated nodes, mismatched current copies, repeated roots and revoked grants without replacing the library", async () => {
    const prior = (await get()).id, code = await grant();
    const unrelated = library(); unrelated.nodes["machine:Unrelated"] = { ...unrelated.nodes["machine:QIDI 0.2"], name: "Unrelated" };
    assert.equal((await save(code, unrelated)).status, 400);
    const mismatch = library(); mismatch.current.nodes["machine:QIDI machine"].saved.value = "different";
    assert.equal((await save(code, mismatch)).status, 400);
    const duplicate = library(); duplicate.profiles.push(duplicate.profiles[0]); assert.equal((await save(code, duplicate)).status, 400);
    assert.equal((await get()).id, prior);
    await dispatch(`/api/orca/connections/${code.id}`, { method: "DELETE", headers: browser });
    assert.equal((await save(code)).status, 401);
  });
  it("rolls back the entire import if its final receipt fails, then safely retries", async () => {
    const exported = async () => (await dispatch("/api/orca/library/export", { headers: browser })).json();
    const before = await exported(), code = await grant(), changed = library();
    changed.nodes["machine:QIDI 0.2"].saved.nozzle_diameter = "0.6";
    await db.prepare(`CREATE TRIGGER fail_orca_import_receipt BEFORE INSERT ON orca_library_imports
      BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END`).run();
    try {
      assert.equal((await save(code, changed)).status, 500);
      assert.deepEqual(await exported(), before);
      assert.equal(await db.prepare("SELECT id FROM orca_library_imports WHERE id = ?").bind(code.id).first(), null);
    } finally {
      await db.prepare("DROP TRIGGER fail_orca_import_receipt").run();
    }
    assert.equal((await save(code, changed)).status, 201);
    assert.equal((await exported()).nodes["machine:QIDI 0.2"].saved.nozzle_diameter, "0.6");
    await dispatch(`/api/orca/connections/${code.id}`, { method: "DELETE", headers: browser });
  });
  it("imports the real native QIDI library when supplied as a local verification fixture", async (context) => {
    if (!process.env.ORCA_LIBRARY_FIXTURE) { context.skip("Private native fixture is local-only"); return; }
    const capture = JSON.parse(await readFile(process.env.ORCA_LIBRARY_FIXTURE, "utf8"));
    const code = await grant(), response = await save(code, capture);
    assert.equal(response.status, 201, JSON.stringify(await response.json()));
    const imported = await get(); assert.equal(imported.profiles.length, capture.profiles.length);
    const download = await (await dispatch("/api/orca/library/export", { headers: browser })).json();
    assert.equal(Object.keys(download.nodes).length, Object.keys(capture.nodes).length);
    assert.deepEqual(download.nodes, capture.nodes);
    assert.deepEqual(download.profiles, capture.profiles);
    assert.deepEqual(download.current, capture.current);
    for (const profile of capture.profiles) {
      const response = await dispatch("/api/orca/library/profile-export?profileId=" + encodeURIComponent(profile.node), { headers: browser });
      assert.equal(response.status, 200);
      const { snapshot } = await response.json();
      const ancestors = {}; let at = profile.node;
      while (at) { ancestors[at] = capture.nodes[at]; at = capture.nodes[at].parent; }
      assert.deepEqual(snapshot.nodes, ancestors);
      assert.deepEqual(snapshot.selections[0].effective, capture.nodes[profile.node].saved);
    }
    await dispatch(`/api/orca/connections/${code.id}`, { method: "DELETE", headers: browser });
  });
});
