import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SESSION_TOKEN, SECOND_SESSION_TOKEN, WORKER_ORIGIN, bootSharedWorker, db, dispatch, disposeSharedWorker } from "./helpers.mjs";

const browser = { cookie: `__Host-klippee_session=${SESSION_TOKEN}`, origin: WORKER_ORIGIN, "content-type": "application/json" };
const other = { ...browser, cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
function snapshot() {
  const nodes = {};
  const selections = [];
  for (const kind of ["machine", "process", "filament"]) {
    const id = `${kind}:QIDI ${kind}`;
    const saved = { inherits: "", value: "saved", print_host: "private-address", api_key: "credential" };
    nodes[id] = { kind, name: `QIDI ${kind}`, parent: null, saved, source_json: { ...saved, unknown: { password: "secret", keep: [1, "x"] } } };
    selections.push({ node: id, slot: kind === "filament" ? 0 : null, dirty: true, effective: { ...saved, value: "edited" }, changes: { value: "edited" } });
  }
  for (let slot = 1; slot < 4; slot++) selections.push({ ...selections[2], slot });
  return { format: "klippee-orca-setup/v1", nodes, selections };
}
async function grant() {
  const response = await dispatch("/api/printers/printer_1/orca-connection", { method: "POST", headers: browser });
  assert.equal(response.status, 201);
  const result = await response.json();
  return { ...result, headers: { authorization: `Bearer ${new URL(result.code).hash.slice(1)}`, "content-type": "application/json" } };
}
function save(connection, capture = snapshot()) {
  return dispatch("/api/orca/capture", { method: "POST", headers: connection.headers,
    body: JSON.stringify({ title: "QIDI four-slot setup", hostVersion: "2.5.0-alpha", hostBuild: "3880f2c5", snapshot: capture }) });
}

describe("worker API: Orca setup capture", () => {
  before(bootSharedWorker);
  after(disposeSharedWorker);

  it("requires an owned printer and trusted browser origin to create grants", async () => {
    assert.equal((await dispatch("/api/printers/printer_1/orca-connection", { method: "POST", headers: { ...browser, origin: "https://elsewhere.test" } })).status, 403);
    assert.equal((await dispatch("/api/printers/printer_1/orca-connection", { method: "POST", headers: other })).status, 404);
    assert.equal((await dispatch("/api/orca/capture", { method: "POST", headers: browser, body: "{}" })).status, 401);
  });

  it("saves a private complete capture with a native bearer, excludes credentials, and makes retries idempotent", async () => {
    const connection = await grant();
    const row = await db.prepare("SELECT token_hash FROM orca_capture_grants WHERE id = ?").bind(connection.id).first();
    assert.notEqual(row.token_hash, new URL(connection.code).hash.slice(1));
    const context = await dispatch("/api/orca/capture/context", { method: "POST", headers: connection.headers });
    assert.equal((await context.json()).printerName, "Bench printer");
    const responses = await Promise.all([save(connection), save(connection)]);
    for (const response of responses) assert.ok([200, 201].includes(response.status));
    const created = await responses[0].json();
    assert.equal(created.setup.printerId, "printer_1");
    assert.equal(created.setup.selections.length, 6);
    assert.deepEqual(created.setup.omittedKeys, ["api_key", "password", "print_host"]);
    const downloaded = await dispatch(`/api/orca/setups/${connection.id}`, { headers: browser });
    const capture = await downloaded.json();
    const serialized = JSON.stringify(capture.snapshot);
    for (const secret of ["private-address", "credential", '"password"']) assert.equal(serialized.includes(secret), false);
    assert.deepEqual(capture.snapshot.nodes["machine:QIDI machine"].source_json.unknown.keep, [1, "x"]);
    assert.equal(capture.snapshot.selections[0].changes.value, "edited");
    assert.match(downloaded.headers.get("content-disposition"), /attachment/);
    assert.equal((await dispatch(`/api/orca/setups/${connection.id}`, { headers: other })).status, 404);
    assert.equal((await dispatch(`/api/orca/setups/${connection.id}`)).status, 401);
    const listed = await dispatch("/api/printers/printer_1/orca-setups", { headers: browser });
    assert.equal((await listed.json()).setups.filter((item) => item.id === connection.id).length, 1);
    // A connection code can create a snapshot, but cannot use user-session routes.
    assert.equal((await dispatch("/api/companion-assets", { headers: connection.headers })).status, 401);
    assert.equal((await dispatch(`/api/orca/setups/${connection.id}`, { headers: connection.headers })).status, 401);
    await dispatch(`/api/orca/setups/${connection.id}`, { method: "DELETE", headers: browser });
    assert.equal((await save(connection)).status, 401);
  });

  it("rejects cycles, missing parents, changed slot order and oversized bodies without consuming the code", async () => {
    const connection = await grant();
    const missing = snapshot(); missing.nodes["machine:QIDI machine"].parent = "machine:missing";
    assert.equal((await save(connection, missing)).status, 400);
    const cycle = snapshot(); cycle.nodes["machine:QIDI machine"].parent = "machine:QIDI machine"; cycle.nodes["machine:QIDI machine"].saved.inherits = "QIDI machine";
    assert.equal((await save(connection, cycle)).status, 400);
    const order = snapshot(); order.selections[3].slot = 3;
    assert.equal((await save(connection, order)).status, 400);
    const huge = snapshot(); huge.nodes["machine:QIDI machine"].saved.value = "x".repeat(512_000);
    assert.equal((await save(connection, huge)).status, 413);
    assert.equal((await save(connection)).status, 201);
    await dispatch(`/api/orca/setups/${connection.id}`, { method: "DELETE", headers: browser });
  });

  it("rejects revoked and expired codes", async () => {
    const connection = await grant();
    await dispatch(`/api/orca/connections/${connection.id}`, { method: "DELETE", headers: browser });
    assert.equal((await save(connection)).status, 401);
    const expired = await grant();
    await db.prepare("UPDATE orca_capture_grants SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(expired.id).run();
    assert.equal((await save(expired)).status, 401);
  });

  it("enforces the saved-setup quota without consuming or partially storing a capture", async () => {
    const connection = await grant();
    const statements = Array.from({ length: 20 }, (_, index) => db.prepare(`INSERT INTO orca_setups
      (id, user_id, printer_id, summary_json, snapshot_json, created_at) VALUES (?, 'user_1', 'printer_1', '{}', '{}', '2026-01-01')`)
      .bind(`quota-setup-${index}`));
    await db.batch(statements);
    assert.equal((await save(connection)).status, 409);
    assert.equal(await db.prepare("SELECT id FROM orca_setups WHERE id = ?").bind(connection.id).first(), null);
    await db.prepare("DELETE FROM orca_setups WHERE id LIKE 'quota-setup-%'").run();
    assert.equal((await save(connection)).status, 201);
    await dispatch(`/api/orca/setups/${connection.id}`, { method: "DELETE", headers: browser });
  });
});
