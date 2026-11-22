import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SESSION_TOKEN, SECOND_SESSION_TOKEN, WORKER_ORIGIN, bootSharedWorker, db, dispatch, disposeSharedWorker, insertPrivatePackage } from "./helpers.mjs";

const browser = { cookie: `__Host-klippee_session=${SESSION_TOKEN}`, origin: WORKER_ORIGIN, "content-type": "application/json" };
const other = { ...browser, cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` };
const profileId = "machine:QIDI fine";
function fixture() {
  const nodes = {}, profiles = [], selections = [];
  for (const kind of ["machine", "process", "filament"]) {
    const id = `${kind}:Base ${kind}`;
    const saved = { inherits: "", value: "saved", print_host: "private-printer.local", api_key: "private-credential" };
    if (kind === "machine") Object.assign(saved, { nozzle_diameter: "0.2", printer_model: "QIDI Plus 4", machine_start_gcode: "G28\nSTART_PRINT", future_setting: "keep me" });
    nodes[id] = { kind, name: `Base ${kind}`, parent: null, saved, source_json: { future_option: ["preserve"], nested: { token: "nested-private-token" } } };
    profiles.push({ node: id, custom: kind !== "machine", enabled: true });
    selections.push({ node: id, slot: kind === "filament" ? 0 : null, dirty: true, effective: { ...saved, value: "unsaved edit" }, changes: {} });
  }
  const current = { format: "klippee-orca-setup/v1", nodes: structuredClone(nodes), selections };
  nodes[profileId] = { kind: "machine", name: "QIDI fine", parent: "machine:Base machine", saved: { inherits: "Base machine", machine_start_gcode: "G28\nSTART_PRINT", custom_setting: "preserve root" }, source_json: null };
  profiles.push({ node: profileId, custom: true, enabled: true });
  return { format: "klippee-orca-library/v1", nodes, profiles, current };
}
async function save(library = fixture(), headers = browser, keepGrant = false) {
  for (const [id] of Object.entries(library.current.nodes)) library.current.nodes[id] = structuredClone(library.nodes[id]);
  for (const selection of library.current.selections) selection.effective = { ...library.nodes[selection.node].saved, value: "unsaved edit" };
  const grant = await (await dispatch("/api/orca/connection", { method: "POST", headers })).json();
  const result = await dispatch("/api/orca/library", { method: "POST", headers: { authorization: `Bearer ${new URL(grant.code).hash.slice(1)}`, "content-type": "application/json" }, body: JSON.stringify({ hostVersion: "2.5.0-alpha", library }) });
  const responseBody = await result.text();
  if (!keepGrant) await dispatch(`/api/orca/connections/${grant.id}`, { method: "DELETE", headers });
  assert.equal(result.status, 201, responseBody);
  return grant;
}
function settings(values, headers = browser) {
  return dispatch("/api/orca/library/publication", { method: "PATCH", headers, body: JSON.stringify({ profileId, ...values }) });
}
async function publicAsset() {
  const candidate = (await review()).review;
  return (await (await dispatch(`/api/public-companion-assets/${new URL(candidate.publicUrl).pathname.split("/").at(-1)}`)).json()).asset;
}
async function review(headers = browser, id = profileId) {
  const response = await dispatch(`/api/orca/library/publication?profileId=${encodeURIComponent(id)}`, { headers });
  return { response, ...(await response.json()) };
}
function publish(candidate, overrides = {}, headers = browser) {
  return dispatch("/api/orca/library/publication", { method: "POST", headers, body: JSON.stringify({
    profileId, importId: candidate.importId, candidateHash: candidate.candidateHash, title: candidate.title, description: "Fine QIDI printer profile",
    confirmPublic: true, acknowledgeSafetyWarnings: true, ...overrides,
  }) });
}

describe("worker API: public Orca library profiles", () => {
  before(bootSharedWorker); after(disposeSharedWorker);
  it("requires browser authentication, ownership, public confirmation and trusted mutation origins", async () => {
    const grant = await save();
    assert.equal((await review({})).response.status, 401);
    assert.equal((await review({ authorization: `Bearer ${new URL(grant.code).hash.slice(1)}` })).response.status, 401);
    assert.equal((await review(other)).response.status, 404);
    const candidate = (await review()).review;
    assert.equal((await publish(candidate, {}, other)).status, 404);
    assert.equal((await publish(candidate, { confirmPublic: false })).status, 400);
    assert.equal((await publish(candidate, {}, { ...browser, origin: "https://elsewhere.test" })).status, 403);
    assert.equal((await publish(candidate, { title: "x".repeat(161) })).status, 400);
  });
  it("publishes only the chosen saved profile with complete ancestry and useful tags, and lists it anonymously", async () => {
    await save();
    const candidate = (await review()).review;
    assert.deepEqual(candidate.tags, ["0.2 mm nozzle", "QIDI Plus 4"]);
    const serialized = JSON.parse(candidate.content);
    assert.deepEqual(Object.keys(serialized.snapshot.nodes).sort(), [profileId, "machine:Base machine"].sort());
    assert.equal(serialized.snapshot.nodes["machine:Base machine"].saved.future_setting, "keep me");
    assert.deepEqual(serialized.snapshot.nodes["machine:Base machine"].source_json.future_option, ["preserve"]);
    assert.equal(candidate.content.includes("private-credential"), false);
    assert.equal(candidate.content.includes("nested-private-token"), false);
    assert.equal(candidate.content.includes("private-printer.local"), false);
    assert.equal(candidate.content.includes("unsaved edit"), false);
    const response = await publish(candidate); assert.equal(response.status, 201);
    const { asset } = await response.json(); assert.equal(asset.version, "1");
    const shared = await (await dispatch(`/api/public-companion-assets/${asset.publicSlug}`)).json();
    assert.equal(shared.asset.content, candidate.content);
    const listed = await (await dispatch("/api/public-companion-assets?kind=machine&nozzle=0.2&q=QIDI")).json();
    assert.equal(listed.assets.length, 1); assert.equal(listed.assets[0].publicSlug, asset.publicSlug);
    assert.equal("content" in listed.assets[0], false); assert.equal("user_id" in listed.assets[0], false);
    assert.deepEqual(listed.nozzleSizes, ["0.2"]);
    assert.equal((await (await dispatch("/api/public-companion-assets?nozzle=0.4")).json()).assets.length, 0);
    assert.equal((await dispatch("/api/public-companion-assets?offset=-1")).status, 400);
    const library = await (await dispatch("/api/orca/library", { headers: browser })).json();
    assert.equal(library.library.profiles.find(profile => profile.id === profileId).publicUrl, asset.publicUrl);
    const foreign = await (await dispatch("/api/orca/library", { headers: other })).json();
    assert.equal(foreign.library, null);
  });
  it("keeps private imports private, rejects stale reviews and preserves public URLs on republish", async () => {
    const old = (await review()).review;
    const prior = (await (await dispatch("/api/public-companion-assets")).json()).assets[0];
    const changed = fixture(); changed.nodes[profileId].saved.custom_setting = "new private change";
    await save(changed);
    assert.equal((await publish(old)).status, 409);
    const publicBefore = (await (await dispatch(`/api/public-companion-assets/${prior.publicSlug}`)).json()).asset;
    assert.equal(publicBefore.content.includes("new private change"), false);
    const candidate = (await review()).review;
    const response = await publish(candidate, { title: "Renamed public profile" }); assert.equal(response.status, 200);
    const { asset } = await response.json();
    assert.equal(asset.publicSlug, prior.publicSlug); assert.equal(asset.version, "2");
    assert.equal(asset.content.includes("new private change"), true);
    assert.equal((await (await dispatch("/api/public-companion-assets?q=Renamed")).json()).assets.length, 1);
  });
  it("detects secrets in inherited G-code, requires warning acknowledgement, and scans public descriptions", async () => {
    const secret = fixture(); secret.nodes["machine:Base machine"].saved.machine_end_gcode = "RUN_SHELL_COMMAND CMD=upload token=very-private-value";
    await save(secret);
    let candidate = (await review()).review;
    assert.ok(candidate.findings.some(finding => finding.severity === "block"));
    assert.equal((await publish(candidate)).status, 422);
    const warning = fixture(); warning.nodes[profileId].saved.machine_end_gcode = "; printer at 192.168.1.100";
    await save(warning); candidate = (await review()).review;
    assert.ok(candidate.findings.some(finding => finding.severity === "warn"));
    assert.equal((await publish(candidate, { acknowledgeSafetyWarnings: false })).status, 422);
    assert.equal((await publish(candidate, { description: "password: very-private-value" })).status, 422);
    assert.equal((await publish(candidate)).status, 200);
  });
  it("hides supporting restore nodes from publication and unpublishes without deleting the private profile", async () => {
    const snapshot = fixture(), name = "_local/klippee-restore-701648225c90-d0/saved-f76a0fdafad87fd5d887", id = `machine:${name}`;
    snapshot.nodes[id] = { kind: "machine", name, parent: null, saved: { inherits: "" }, source_json: null };
    snapshot.profiles.push({ node: id, custom: false, enabled: true });
    await save(snapshot);
    assert.equal((await review(browser, id)).response.status, 404);
    const candidate = (await review()).review; const url = new URL(candidate.publicUrl);
    const path = `/api/orca/library/publication?profileId=${encodeURIComponent(profileId)}`;
    assert.equal((await dispatch(path, { method: "DELETE", headers: other })).status, 200);
    assert.equal((await dispatch(`/api/public-companion-assets/${url.pathname.split("/").at(-1)}`)).status, 200);
    assert.equal((await dispatch(path, { method: "DELETE", headers: browser })).status, 200);
    assert.equal((await dispatch(`/api/public-companion-assets/${url.pathname.split("/").at(-1)}`)).status, 404);
    assert.equal((await review()).response.status, 200);
    assert.equal((await (await dispatch("/api/orca/library", { headers: browser })).json()).library.profiles.some(profile => profile.id === profileId), true);
    assert.equal((await (await dispatch("/api/public-companion-assets")).json()).assets.length, 0);
  });
  it("links profiles to owned public configs in both directions and protects publication settings", async () => {
    await save();
    const published = await publish((await review()).review); assert.equal(published.status, 201);
    const files = [{ path: "macros.cfg", role: "macros", public: true, content: "[gcode_macro PRINT_START]\ngcode:\n  G28\n" }];
    await insertPrivatePackage("orca-linked-config", files);
    const configResponse = await dispatch("/api/public-packages", { method: "POST", headers: browser, body: JSON.stringify({ package: { id: "orca-linked-config" }, acknowledgeSafetyWarnings: true }) });
    assert.equal(configResponse.status, 201, await configResponse.clone().text());
    const config = await configResponse.json();
    assert.equal((await settings({ autoUpdateEnabled: true }, { origin: WORKER_ORIGIN, "content-type": "application/json" })).status, 401);
    assert.equal((await settings({ autoUpdateEnabled: true }, other)).status, 404);
    assert.equal((await settings({ autoUpdateEnabled: true }, { ...browser, origin: "https://elsewhere.test" })).status, 403);
    assert.equal((await settings({ printerConfigSlug: "private-or-foreign" })).status, 404);
    assert.equal((await settings({ autoUpdateEnabled: "true" })).status, 400);
    const before = await publicAsset();
    const updated = await settings({ printerConfigSlug: config.slug, autoUpdateEnabled: true });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).publication.autoUpdateEnabled, true);
    const after = await publicAsset();
    assert.equal(after.version, before.version); assert.equal(after.content, before.content);
    assert.equal(after.printerConfig.slug, config.slug);
    const linked = await (await dispatch(`/api/public-packages/${config.slug}/orca-profiles`)).json();
    assert.equal(linked.assets.length, 1); assert.equal(linked.assets[0].publicSlug, after.publicSlug);
    assert.equal("content" in linked.assets[0], false);
    assert.deepEqual((await (await dispatch("/api/public-packages/missing/orca-profiles")).json()).assets, []);
    const ownerLibrary = await (await dispatch("/api/orca/library", { headers: browser })).json();
    const profile = ownerLibrary.library.profiles.find(p => p.id === profileId);
    assert.equal(profile.autoUpdateEnabled, true); assert.equal(profile.printerConfig.slug, config.slug);
    // A second account cannot attach its profile to this owner's configuration.
    await save(fixture(), other);
    const otherCandidate = (await review(other)).review;
    assert.equal((await publish(otherCandidate, { printerConfigSlug: config.slug }, other)).status, 404);
  });
  it("automatically publishes saved ancestry and nozzle changes without changing metadata or links", async () => {
    const before = await publicAsset();
    const changed = fixture(); changed.nodes[profileId].saved.nozzle_diameter = "0.6";
    changed.nodes["machine:Base machine"].saved.future_setting = "changed ancestor";
    const priorGrant = await save(changed, browser, true);
    let updated = await publicAsset();
    assert.equal(updated.version, String(Number(before.version) + 1));
    assert.equal(updated.title, before.title); assert.equal(updated.description, before.description);
    assert.equal(updated.publicSlug, before.publicSlug); assert.deepEqual(updated.printerConfig, before.printerConfig);
    assert.ok(updated.tags.includes("0.6 mm nozzle"));
    assert.equal(JSON.parse(updated.content).snapshot.nodes["machine:Base machine"].saved.future_setting, "changed ancestor");
    assert.equal(updated.content.includes("unsaved edit"), false); assert.equal(updated.content.includes("private-credential"), false);
    const latest = fixture(); latest.nodes[profileId].saved.nozzle_diameter = "0.8";
    await save(latest); updated = await publicAsset(); const latestVersion = updated.version;
    // A retry receipt for an older import must not revert the newer publication.
    const retried = await dispatch("/api/orca/library", { method: "POST", headers: { authorization: `Bearer ${new URL(priorGrant.code).hash.slice(1)}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(retried.status, 200); assert.equal((await publicAsset()).version, latestVersion);
    assert.ok((await publicAsset()).tags.includes("0.8 mm nozzle"));
    await dispatch(`/api/orca/connections/${priorGrant.id}`, { method: "DELETE", headers: browser });
    await save(latest); assert.equal((await publicAsset()).version, latestVersion);
    const first = fixture(), second = fixture();
    first.nodes[profileId].saved.nozzle_diameter = "0.2"; second.nodes[profileId].saved.nozzle_diameter = "0.4";
    await Promise.all([save(first), save(second)]);
    const current = await (await dispatch("/api/orca/library/profile-export?profileId=" + encodeURIComponent(profileId), { headers: browser })).json();
    assert.deepEqual(JSON.parse((await publicAsset()).content), current);
  });
  it("pauses unsafe imports, accepts manual review, respects disable and removal, and keeps successful imports private", async () => {
    let previous = await publicAsset();
    const unsafe = fixture(); unsafe.nodes[profileId].saved.machine_start_gcode = "RUN_SHELL_COMMAND CMD=upload token=very-private-value";
    await save(unsafe);
    assert.equal((await publicAsset()).content, previous.content);
    assert.match((await review()).review.autoUpdateError, /needs review/);
    assert.equal((await review()).review.autoUpdateEnabled, true);
    const warned = fixture(); warned.nodes[profileId].saved.machine_end_gcode = "; printer at 192.168.1.100";
    await save(warned); assert.equal((await publicAsset()).content, previous.content);
    const approved = await publish((await review()).review); assert.equal(approved.status, 200);
    assert.equal((await review()).review.autoUpdateError, null); assert.equal((await review()).review.autoUpdateEnabled, true);
    previous = await publicAsset(); await save(warned); assert.equal((await publicAsset()).version, previous.version);
    await settings({ autoUpdateEnabled: false }); await save();
    assert.equal((await publicAsset()).content, previous.content);
    await settings({ autoUpdateEnabled: true }); previous = await publicAsset();
    assert.equal(previous.content.includes("192.168.1.100"), false);
    const missing = fixture(); delete missing.nodes[profileId]; missing.profiles = missing.profiles.filter(p => p.node !== profileId);
    await save(missing);
    const listing = await db.prepare("SELECT auto_update_error FROM public_companion_assets WHERE slug = ?").bind(previous.publicSlug).first();
    assert.match(listing.auto_update_error, /missing/);
    assert.equal((await settings({ autoUpdateEnabled: false })).status, 200);
    assert.equal((await settings({ autoUpdateEnabled: true })).status, 404);
    await save(); assert.equal((await settings({ autoUpdateEnabled: true })).status, 200);
    await settings({ printerConfigSlug: null }); assert.equal((await publicAsset()).printerConfig, null);
    await dispatch(`/api/orca/library/publication?profileId=${encodeURIComponent(profileId)}`, { method: "DELETE", headers: browser });
    await save();
    assert.equal((await dispatch(`/api/public-companion-assets/${previous.publicSlug}`)).status, 404);
    assert.equal((await review()).review.publicUrl, null);
  });
  it("isolates identical preset names across owners and rejects oversized public snapshots", async () => {
    await save(fixture(), other);
    const foreign = (await review(other)).review;
    const published = await publish(foreign, {}, other); assert.equal(published.status, 201);
    const sharedForeign = (await published.json()).asset;
    const local = (await review()).review;
    const localPublished = await publish(local); assert.equal(localPublished.status, 201);
    const sharedLocal = (await localPublished.json()).asset;
    assert.notEqual(sharedLocal.publicSlug, sharedForeign.publicSlug);
    await dispatch(`/api/orca/library/publication?profileId=${encodeURIComponent(profileId)}`, { method: "DELETE", headers: other });
    assert.equal((await dispatch(`/api/public-companion-assets/${sharedLocal.publicSlug}`)).status, 200);
    const oversized = fixture(); oversized.nodes[profileId].saved.large_gcode = "X".repeat(490_000);
    await save(oversized);
    assert.equal((await review()).response.status, 413);
  });
  it("enforces a bounded public catalog quota while allowing existing listing updates", async () => {
    const imported = await save(); let candidate = (await review()).review;
    const created = await publish(candidate); assert.equal(created.status, 200);
    const { asset } = await created.json();
    const owner = await db.prepare("SELECT user_id FROM orca_libraries WHERE import_id = ?").bind(imported.id).first();
    const timestamp = "2026-10-18T00:00:00Z";
    await db.batch(Array.from({ length: 63 }, (_, i) => db.prepare(`INSERT INTO public_companion_assets (id,user_id,source_asset_id,slug,kind,title,asset_json,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(`quota-${i}`, owner.user_id, `quota-${i}`, `quota-${i}`, "machine", `QIDI ${i}`, JSON.stringify({ ...asset, tags: ["0.4 mm nozzle"], publicSlug: undefined, publicUrl: undefined }), timestamp, timestamp, timestamp)));
    candidate = (await review()).review; assert.equal((await publish(candidate)).status, 200);
    const otherProfile = "machine:Base machine", second = (await review(browser, otherProfile)).review;
    const overQuota = await publish(second, { profileId: otherProfile });
    assert.equal(overQuota.status, 409); assert.equal((await overQuota.json()).code, "storage_quota_exceeded");
    const page1 = await (await dispatch("/api/public-companion-assets")).json(); assert.equal(page1.assets.length, 24); assert.equal(page1.nextOffset, 24);
    const page2 = await (await dispatch(`/api/public-companion-assets?offset=${page1.nextOffset}`)).json();
    assert.equal(page2.assets.length, 24); assert.equal(page2.assets.some(item => page1.assets.some(first => first.publicSlug === item.publicSlug)), false);
  });
});
