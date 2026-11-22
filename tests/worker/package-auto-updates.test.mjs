import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { unzipSync } from "fflate";
import {
  SECOND_SESSION_TOKEN, SESSION_TOKEN, WORKER_ORIGIN,
  bootSharedWorker, db, dispatch, disposeSharedWorker, insertPrivatePackage,
} from "./helpers.mjs";

const ownerHeaders = {
  cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
  "content-type": "application/json",
  origin: WORKER_ORIGIN,
};
function files(value) {
  return [{ path: "printer.cfg", role: "printer", public: false,
    content: `[printer]\nkinematics: corexy\nmax_velocity: ${value}\n` }];
}
async function request(path, body, method = "POST", headers = ownerHeaders, expected = 200) {
  const response = await dispatch(path, { method, headers, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
async function fixture(name, initialFiles = files(100)) {
  const packageId = `auto-${name}`;
  await insertPrivatePackage(packageId, initialFiles);
  const { repository } = await request("/api/repos", { name: packageId, title: packageId, files: initialFiles }, "POST", ownerHeaders, 201);
  const printerId = `printer-${packageId}`;
  await request("/api/printers", { printer: { id: printerId, name: packageId, repositoryId: repository.id } }, "POST", ownerHeaders, 201);
  const { token } = await request(`/api/repos/${repository.id}/sync-tokens`, {
    name: packageId, printerId, scopes: ["repo:read", "repo:write"],
  }, "POST", ownerHeaders, 201);
  const syncHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const apply = (appliedFiles) => request(`/api/sync/repos/${repository.id}/applied`, { files: appliedFiles }, "POST", syncHeaders);
  await request(`/api/sync/repos/${repository.id}/applied`, { versionNumber: 1 }, "POST", syncHeaders);
  const { candidate } = await (await dispatch(`/api/printers/${printerId}/publication-candidate`, { headers: ownerHeaders })).json();
  const published = await request("/api/public-packages", {
    packageId, printerId, repositoryId: repository.id,
    expectedAppliedVersionId: candidate.versionId, acknowledgeSafetyWarnings: true,
  }, "POST", ownerHeaders, 201);
  const status = async () => (await (await dispatch(`/api/public-packages/${published.slug}/status`, { headers: ownerHeaders })).json()).status;
  const detail = async () => (await (await dispatch(`/api/packages/${published.slug}`)).json()).package;
  const enable = (enabled = true) => request(`/api/public-packages/${published.slug}/auto-update`, { enabled }, "PATCH");
  return { apply, detail, enable, packageId, printerId, published, repository, status, syncHeaders };
}

describe("automatic registry updates", () => {
  before(bootSharedWorker);
  after(disposeSharedWorker);

  it("defaults off, catches up on opt-in, follows applied changes and stops when disabled", async () => {
    const f = await fixture("lifecycle");
    assert.equal((await f.status()).autoUpdateEnabled, false);
    await f.apply(files(200));
    assert.match((await f.detail()).files[0].content, /max_velocity: 100/);
    assert.equal((await f.status()).hasUnpublishedAppliedVersion, true);
    const enabled = await f.enable();
    assert.equal(enabled.status.autoUpdateEnabled, true);
    assert.equal(enabled.status.hasUnpublishedAppliedVersion, false);
    assert.match((await f.detail()).files[0].content, /max_velocity: 200/);
    // A public metadata edit must survive subsequent automatic publications.
    await request(`/api/public-packages/${f.published.slug}`, {
      title: "Owner's public title", description: "Kept public description", printer: "Plus4", hardware: ["Beacon"], tags: ["fixture"],
    }, "PATCH");
    await dispatch("/api/packages"); // Populate the catalog cache before updating.
    await f.apply(files(300));
    const current = await f.detail();
    assert.equal(current.title, "Owner's public title");
    assert.equal(current.publicSlug, f.published.slug);
    assert.match(current.files[0].content, /max_velocity: 300/);
    assert.equal((await f.status()).autoUpdateError, null);
    assert.equal((await f.status()).hasUnpublishedAppliedVersion, false);
    const catalog = await dispatch("/api/packages");
    assert.equal(catalog.headers.get("x-klippee-cache"), "MISS");
    const download = await dispatch(`/api/packages/${f.published.slug}/download.zip`);
    assert.equal(download.status, 200);
    const zip = unzipSync(new Uint8Array(await download.arrayBuffer()));
    assert.match(new TextDecoder().decode(zip["printer.cfg"]), /max_velocity: 300/);
    await f.enable(false);
    await f.apply(files(400));
    assert.match((await f.detail()).files[0].content, /max_velocity: 300/);
    assert.equal((await f.status()).hasUnpublishedAppliedVersion, true);
  });

  it("keeps desktop captures private until applied and excludes private files and variable values", async () => {
    const runtime = { path: "saved_variables.cfg", role: "include", public: false, content: "runtime_data: keep-private\n" };
    const f = await fixture("draft", files(100).concat([runtime]));
    await f.enable();
    const desktop = await request(`/api/repos/${f.repository.id}/sync-tokens`, {
      name: "Desktop draft", clientMode: "desktop", printerId: f.printerId, scopes: ["repo:read", "repo:write"],
    }, "POST", ownerHeaders, 201);
    const nextFiles = files(250).concat([
      { path: "beacon.cfg", role: "include", public: false, content: "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n" },
    ]);
    await request(`/api/sync/repos/${f.repository.id}/push`, { files: nextFiles.concat([runtime]) }, "POST", {
      authorization: `Bearer ${desktop.token}`, "content-type": "application/json",
    }, 422);
    await request(`/api/sync/repos/${f.repository.id}/push`, { files: nextFiles }, "POST", {
      authorization: `Bearer ${desktop.token}`, "content-type": "application/json",
    }, 202);
    assert.match((await f.detail()).files[0].content, /max_velocity: 100/);
    await f.apply(nextFiles);
    const published = await f.detail();
    assert.match(published.files[0].content, /max_velocity: 250/);
    assert.deepEqual(published.files.map((file) => file.path).sort(), ["beacon.cfg", "printer.cfg"]);
    assert.match(published.files.find((file) => file.path === "beacon.cfg").content, /\$\{KLIPPEE:beacon_serial\}/);
    assert.equal(published.variables.some((variable) => variable.name === "beacon_serial"), true);
    assert.equal(JSON.stringify(published).includes("keep-private"), false);
  });

  it("follows physical captures, including idempotent capture retries", async () => {
    const f = await fixture("capture");
    await f.enable();
    const captured = await request(`/api/sync/repos/${f.repository.id}/push`, { files: files(275) }, "POST", f.syncHeaders, 201);
    assert.match((await f.detail()).files[0].content, /max_velocity: 275/);
    // Simulate a publication which failed after the physical capture succeeded.
    await db.prepare("UPDATE public_packages SET approved_version_id = NULL, auto_update_error = 'retry' WHERE slug = ?")
      .bind(f.published.slug).run();
    const retry = await request(`/api/sync/repos/${f.repository.id}/push`, { files: files(275) }, "POST", f.syncHeaders);
    assert.equal(retry.unchanged, true);
    assert.equal((await f.status()).approvedVersionId, captured.version.id);
    assert.equal((await f.status()).autoUpdateError, null);
  });

  it("reports publication safety problems without failing the printer apply, then recovers", async () => {
    const f = await fixture("review");
    await f.enable();
    await f.apply(files(200).concat([{ path: "beacon.cfg", role: "include", public: false,
      content: "[beacon]\nserial: /dev/serial/by-id/usb-private-printer\n" }]));
    const blocked = await f.status();
    assert.equal(blocked.hasUnpublishedAppliedVersion, true);
    assert.match(blocked.autoUpdateError, /needs review/);
    assert.match((await f.detail()).files[0].content, /max_velocity: 100/);
    assert.equal(JSON.stringify(await f.detail()).includes("usb-private-printer"), false);
    await f.apply(files(300));
    assert.equal((await f.status()).hasUnpublishedAppliedVersion, false);
    assert.equal((await f.status()).autoUpdateError, null);
    assert.match((await f.detail()).files[0].content, /max_velocity: 300/);
  });

  it("requires owner authentication and a linked printer, validates the setting and prevents CSRF", async () => {
    const f = await fixture("permissions");
    const path = `/api/public-packages/${f.published.slug}/auto-update`;
    await request(path, { enabled: true }, "PATCH", { "content-type": "application/json", origin: WORKER_ORIGIN }, 401);
    await request(path, { enabled: true }, "PATCH", { ...ownerHeaders, cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}` }, 404);
    await request(path, { enabled: true }, "PATCH", { ...f.syncHeaders, origin: WORKER_ORIGIN }, 401);
    await request(path, { enabled: true }, "PATCH", { ...ownerHeaders, origin: "https://evil.example" }, 403);
    await request(path, { enabled: "true" }, "PATCH", ownerHeaders, 400);
    assert.equal((await f.status()).autoUpdateEnabled, false);
    await db.prepare("UPDATE public_packages SET printer_id = NULL, repository_id = NULL WHERE slug = ?").bind(f.published.slug).run();
    await request(path, { enabled: true }, "PATCH", ownerHeaders, 409);
  });

  it("keeps a successful printer apply when registry storage fails and supports retry", async () => {
    const f = await fixture("storage-failure");
    await f.enable();
    await db.prepare(`CREATE TRIGGER fail_auto_publication BEFORE UPDATE OF package_json ON public_packages
      WHEN OLD.slug = '${f.published.slug}' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`).run();
    try {
      await f.apply(files(360));
      const status = await f.status();
      assert.equal(status.hasUnpublishedAppliedVersion, true);
      assert.match(status.autoUpdateError, /failed/);
      assert.match((await f.detail()).files[0].content, /max_velocity: 100/);
    } finally {
      await db.prepare("DROP TRIGGER fail_auto_publication").run();
    }
    await f.enable();
    assert.match((await f.detail()).files[0].content, /max_velocity: 360/);
    assert.equal((await f.status()).autoUpdateError, null);
  });

  it("does not follow another printer sharing the repository and disables on a rebind", async () => {
    const f = await fixture("binding");
    await f.enable();
    const otherId = "other-auto-printer";
    await request("/api/printers", { printer: { id: otherId, name: otherId, repositoryId: f.repository.id } }, "POST", ownerHeaders, 201);
    const otherToken = await request(`/api/repos/${f.repository.id}/sync-tokens`, {
      name: "Other printer", printerId: otherId, scopes: ["repo:read", "repo:write"],
    }, "POST", ownerHeaders, 201);
    await request(`/api/sync/repos/${f.repository.id}/applied`, { files: files(450) }, "POST", {
      authorization: `Bearer ${otherToken.token}`, "content-type": "application/json",
    });
    assert.match((await f.detail()).files[0].content, /max_velocity: 100/);
    await request("/api/printers", { printer: { id: f.printerId, name: "Rebound", repositoryId: null } }, "POST", ownerHeaders);
    const status = await f.status();
    assert.equal(status.linked, false);
    assert.equal(status.autoUpdateEnabled, false);
    assert.equal((await db.prepare("SELECT auto_update_enabled FROM public_packages WHERE slug = ?").bind(f.published.slug).first()).auto_update_enabled, 0);
    assert.match((await f.detail()).files[0].content, /max_velocity: 100/);
  });

  it("requires a new opt-in if a listing is manually published from a different printer", async () => {
    const f = await fixture("publication-rebind");
    await f.enable();
    const otherId = "publication-rebind-other";
    await request("/api/printers", { printer: { id: otherId, name: otherId, repositoryId: f.repository.id } }, "POST", ownerHeaders, 201);
    const otherToken = await request(`/api/repos/${f.repository.id}/sync-tokens`, {
      name: "Other publication printer", printerId: otherId, scopes: ["repo:read", "repo:write"],
    }, "POST", ownerHeaders, 201);
    await request(`/api/sync/repos/${f.repository.id}/applied`, { files: files(480) }, "POST", {
      authorization: `Bearer ${otherToken.token}`, "content-type": "application/json",
    });
    const { candidate } = await (await dispatch(`/api/printers/${otherId}/publication-candidate`, { headers: ownerHeaders })).json();
    await request("/api/public-packages", {
      packageId: f.packageId, printerId: otherId, repositoryId: f.repository.id,
      expectedAppliedVersionId: candidate.versionId, acknowledgeSafetyWarnings: true,
    }, "POST", ownerHeaders, 201);
    assert.equal((await f.status()).autoUpdateEnabled, false);
    assert.match((await f.detail()).files[0].content, /max_velocity: 480/);
  });
  it("honors tighter private secret definitions without copying private metadata", async () => {
    const identityFile = { path: "identity.cfg", role: "macro", public: false,
      content: "[gcode_macro IDENTITY]\ngcode: M117 ${KLIPPEE:machine_identity}\n" };
    const f = await fixture("secrecy", files(100).concat([identityFile]));
    await f.enable();
    await insertPrivatePackage(f.packageId, files(300).concat([identityFile]), [], [{
      name: "machine_identity", label: "Identity", type: "string", required: true, secret: true,
      description: "private-description-never-publish", example: "private-example-never-publish",
    }]);
    await db.prepare("UPDATE printers SET package_ids_json = ?, variable_values_json = ? WHERE id = ?")
      .bind(JSON.stringify([f.published.slug]), JSON.stringify({ machine_identity: "local-value-never-publish" }), f.printerId).run();
    await f.apply(files(300).concat([identityFile]));
    const published = await f.detail();
    assert.equal(published.variables.find((variable) => variable.name === "machine_identity").secret, true);
    assert.equal(JSON.stringify(published).includes("never-publish"), false);
    const printer = await db.prepare("SELECT variable_values_json FROM printers WHERE id = ?").bind(f.printerId).first();
    assert.equal("machine_identity" in JSON.parse(printer.variable_values_json), false);
  });
});
