import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  SESSION_TOKEN,
  WORKER_ORIGIN,
  bootSharedWorker,
  db,
  dispatch,
  disposeSharedWorker,
} from "./helpers.mjs";

describe("worker API smoke: sync", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("captures a version only when the printer applies staged pending config", async () => {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO printers
       (id, user_id, name, description, make, model, source, definition_json, package_ids_json, variable_values_json,
        repository_id, latest_version_id, applied_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "printer_pending",
        "user_1",
        "Pending printer",
        "",
        "",
        "",
        "manual",
        "{}",
        "[]",
        JSON.stringify({ beacon_serial: "/dev/serial/by-id/beacon-profile" }),
        null,
        0,
        0,
        now,
        now,
      )
      .run();

    const sessionHeaders = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };

    const createRepo = await dispatch("/api/repos", {
      body: JSON.stringify({ empty: true, name: "pending-printer", title: "Pending printer" }),
      headers: sessionHeaders,
      method: "POST",
    });
    const repoBody = await createRepo.json();
    assert.equal(createRepo.status, 201);
    const repositoryId = repoBody.repository.id;

    const createToken = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      body: JSON.stringify({ name: "Pending token", printerId: "printer_pending", scopes: ["repo:read", "repo:write"] }),
      headers: sessionHeaders,
      method: "POST",
    });
    const tokenBody = await createToken.json();
    assert.equal(createToken.status, 201);

    const createDesktopToken = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      body: JSON.stringify({
        clientMode: "desktop",
        name: "Pending printer desktop sync token",
        printerId: "printer_pending",
        scopes: ["repo:read", "repo:write"],
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    const desktopTokenBody = await createDesktopToken.json();
    assert.equal(createDesktopToken.status, 201);

    const stagedFiles = [{
      content: "[printer]\nkinematics: corexy\nserial: /dev/serial/by-id/beacon-literal\n",
      path: "printer.cfg",
      public: false,
      role: "entrypoint",
    }];

    // The web stages the desired config (session-authenticated); no version yet.
    const stage = await dispatch(`/api/repos/${repositoryId}/pending`, {
      body: JSON.stringify({ baseRevision: null, files: stagedFiles }),
      headers: sessionHeaders,
      method: "PUT",
    });
    const stageBody = await stage.json();
    assert.equal(stage.status, 200);
    assert.equal(typeof stageBody.desired.revision, "string");
    const beforeApply = await db.prepare("SELECT COUNT(*) AS count FROM repository_versions WHERE repository_id = ?")
      .bind(repositoryId)
      .first();
    const stagedRepository = await db.prepare(
      "SELECT pending_files_json FROM repositories WHERE id = ?",
    ).bind(repositoryId).first();
    assert.equal(beforeApply.count, 0);
    assert.equal(Array.isArray(JSON.parse(stagedRepository.pending_files_json)), true);

    const desiredOnlyHistory = await dispatch(`/api/repos/${repositoryId}/versions`, {
      headers: sessionHeaders,
    });
    const desiredOnlyHistoryBody = await desiredOnlyHistory.json();
    assert.equal(desiredOnlyHistory.status, 200);
    assert.deepEqual(desiredOnlyHistoryBody.versions, []);
    assert.equal(desiredOnlyHistoryBody.desired.pending, true);
    assert.deepEqual(desiredOnlyHistoryBody.desired.files, stagedFiles);

    // The printer's pull previews the pending config as the next version.
    const printerPull = await dispatch(`/api/sync/repos/${repositoryId}/pull`, {
      headers: { authorization: `Bearer ${tokenBody.token}` },
    });
    const printerPullBody = await printerPull.json();
    assert.equal(printerPull.status, 200);
    assert.equal(printerPullBody.version.version_number, 1);
    assert.equal(printerPullBody.version.source, "pending");
    assert.match(printerPullBody.version.files[0].content, /kinematics: corexy/);

    // The desktop CLI also previews the pending config but never materializes it.
    const desktopPull = await dispatch(`/api/sync/repos/${repositoryId}/pull`, {
      headers: { authorization: `Bearer ${desktopTokenBody.token}` },
    });
    const desktopPullBody = await desktopPull.json();
    assert.equal(desktopPull.status, 200);
    assert.equal(desktopPullBody.version.source, "pending");
    const afterDesktopPull = await db.prepare("SELECT COUNT(*) AS count FROM repository_versions WHERE repository_id = ?")
      .bind(repositoryId)
      .first();
    assert.equal(afterDesktopPull.count, 0);

    // A newer draft arriving after pull must not rewrite what the printer
    // actually installed or get deleted by the older apply report.
    const newerFiles = [{
      content: "[printer]\nkinematics: corexy\nserial: ${KLIPPEE:beacon_serial}\nmax_velocity: 350\n",
      path: "printer.cfg",
      public: false,
      role: "entrypoint",
    }];
    const newerStage = await dispatch(`/api/repos/${repositoryId}/pending`, {
      body: JSON.stringify({ baseRevision: printerPullBody.version.revision, files: newerFiles }),
      headers: sessionHeaders,
      method: "PUT",
    });
    const newerStageBody = await newerStage.json();
    assert.equal(newerStage.status, 200);

    const staleBrowserStage = await dispatch(`/api/repos/${repositoryId}/pending`, {
      body: JSON.stringify({ baseRevision: printerPullBody.version.revision, files: stagedFiles }),
      headers: sessionHeaders,
      method: "PUT",
    });
    const staleBrowserStageBody = await staleBrowserStage.json();
    assert.equal(staleBrowserStage.status, 409);
    assert.equal(staleBrowserStageBody.code, "desired_configuration_conflict");
    assert.equal(staleBrowserStageBody.current.revision, newerStageBody.desired.revision);

    // Applying on the physical printer is the only moment a version is captured.
    const applied = await dispatch(`/api/sync/repos/${repositoryId}/applied`, {
      body: JSON.stringify({
        desiredRevision: printerPullBody.version.revision,
        files: stagedFiles,
        protocolVersion: 2,
        versionNumber: 1,
      }),
      headers: { authorization: `Bearer ${tokenBody.token}`, "content-type": "application/json" },
      method: "POST",
    });
    const appliedBody = await applied.json();
    assert.equal(applied.status, 200);
    assert.equal(appliedBody.appliedVersion.version_number, 1);
    assert.equal(appliedBody.desiredChanged, true);

    const version = await db.prepare("SELECT version_number, source FROM repository_versions WHERE repository_id = ?")
      .bind(repositoryId)
      .first();
    assert.equal(version.version_number, 1);
    assert.equal(version.source, "printer-apply");
    const repoAfter = await db.prepare("SELECT pending_files_json FROM repositories WHERE id = ?")
      .bind(repositoryId)
      .first();
    assert.notEqual(repoAfter.pending_files_json, null);
    const printerAfter = await db.prepare("SELECT applied_version_id, applied_at, latest_version_id FROM printers WHERE id = ?")
      .bind("printer_pending")
      .first();
    assert.equal(printerAfter.applied_version_id, 1);
    assert.equal(printerAfter.latest_version_id, 1);
    assert.equal(typeof printerAfter.applied_at, "string");

    // Browser reloads must hydrate the authoritative pending desired files,
    // not just the newest immutable capture. The immutable version is still a
    // literal while the pending editor snapshot retains its variable marker.
    const browserVersions = await dispatch(`/api/repos/${repositoryId}/versions`, {
      headers: sessionHeaders,
    });
    const browserVersionsBody = await browserVersions.json();
    assert.equal(browserVersions.status, 200);
    assert.match(browserVersionsBody.versions[0].files[0].content, /beacon-literal/);
    assert.equal(browserVersionsBody.desired.pending, true);
    assert.match(browserVersionsBody.desired.files[0].content, /\$\{KLIPPEE:beacon_serial\}/);
    assert.equal(browserVersionsBody.desired.revision, newerStageBody.desired.revision);

    // A pull after apply still serves the newer draft.
    const pullAfter = await dispatch(`/api/sync/repos/${repositoryId}/pull`, {
      headers: { authorization: `Bearer ${tokenBody.token}` },
    });
    const pullAfterBody = await pullAfter.json();
    assert.equal(pullAfterBody.version.source, "pending");
    assert.equal(pullAfterBody.version.version_number, 2);
    assert.match(pullAfterBody.version.files[0].content, /max_velocity: 350/);

    // A desktop capture with a missing local template sidecar sends rendered
    // literals. Its exact baseline proves the pending desired snapshot was the
    // source, so the server can safely retain the variable declaration.
    const desktopRenderedFiles = newerFiles.map((file) => ({
      ...file,
      content: file.content.replace(
        "${KLIPPEE:beacon_serial}",
        "/dev/serial/by-id/beacon-profile",
      ),
    }));
    const desktopCapture = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        baseRevision: pullAfterBody.version.revision,
        files: desktopRenderedFiles,
        message: "Desktop capture without sidecar",
        protocolVersion: 2,
      }),
      headers: {
        authorization: `Bearer ${desktopTokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const desktopCaptureBody = await desktopCapture.json();
    assert.equal(desktopCapture.status, 200);
    assert.equal(desktopCaptureBody.unchanged, true);
    assert.match(desktopCaptureBody.version.files[0].content, /\$\{KLIPPEE:beacon_serial\}/);

    const applyNewer = await dispatch(`/api/sync/repos/${repositoryId}/applied`, {
      body: JSON.stringify({
        desiredRevision: pullAfterBody.version.revision,
        files: newerFiles,
        protocolVersion: 2,
        versionNumber: 2,
      }),
      headers: { authorization: `Bearer ${tokenBody.token}`, "content-type": "application/json" },
      method: "POST",
    });
    const applyNewerBody = await applyNewer.json();
    assert.equal(applyNewer.status, 200);
    assert.equal(applyNewerBody.appliedVersion.version_number, 2);
    assert.equal(applyNewerBody.desiredChanged, false);

    // Staging identical content then applying does not create a duplicate version.
    await dispatch(`/api/repos/${repositoryId}/pending`, {
      body: JSON.stringify({ baseRevision: applyNewerBody.appliedVersion.revision, files: newerFiles }),
      headers: sessionHeaders,
      method: "PUT",
    });
    const reapply = await dispatch(`/api/sync/repos/${repositoryId}/applied`, {
      body: JSON.stringify({
        desiredRevision: pullAfterBody.version.revision,
        files: newerFiles,
        protocolVersion: 2,
        versionNumber: 2,
      }),
      headers: { authorization: `Bearer ${tokenBody.token}`, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(reapply.status, 200);
    const finalCount = await db.prepare("SELECT COUNT(*) AS count FROM repository_versions WHERE repository_id = ?")
      .bind(repositoryId)
      .first();
    assert.equal(finalCount.count, 2);

    // The newest immutable snapshot remains a valid recovery target while a
    // pending draft overrides it. Cancelling that draft must not fabricate a
    // duplicate history version.
    const unwantedFiles = [{
      content: "[printer]\nkinematics: corexy\nserial: /dev/serial/by-id/beacon-profile\nmax_velocity: 999\n",
      path: "printer.cfg",
      public: false,
      role: "entrypoint",
    }];
    const unwantedStage = await dispatch(`/api/repos/${repositoryId}/pending`, {
      body: JSON.stringify({ baseRevision: pullAfterBody.version.revision, files: unwantedFiles }),
      headers: sessionHeaders,
      method: "PUT",
    });
    const unwantedStageBody = await unwantedStage.json();
    assert.equal(unwantedStage.status, 200);

    // An exact desired baseline is the sole authority. This draft intentionally
    // hardcodes the old applied variable's value, so applied-template fallback
    // must not resurrect the removed marker.
    const intentionalLiteralCapture = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        baseRevision: unwantedStageBody.desired.revision,
        files: unwantedFiles,
        message: "Intentionally remove variable",
        protocolVersion: 2,
      }),
      headers: {
        authorization: `Bearer ${desktopTokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const intentionalLiteralCaptureBody = await intentionalLiteralCapture.json();
    assert.equal(intentionalLiteralCapture.status, 200);
    assert.equal(intentionalLiteralCaptureBody.unchanged, true);
    assert.doesNotMatch(intentionalLiteralCaptureBody.version.files[0].content, /\$\{KLIPPEE:/);

    const cancelDraft = await dispatch(`/api/sync/repos/${repositoryId}/rollback`, {
      body: JSON.stringify({ versionNumber: 2 }),
      headers: { authorization: `Bearer ${tokenBody.token}`, "content-type": "application/json" },
      method: "POST",
    });
    const cancelDraftBody = await cancelDraft.json();
    assert.equal(cancelDraft.status, 200);
    assert.equal(cancelDraftBody.cancelledDraft, true);
    assert.equal(cancelDraftBody.version.version_number, 2);
    assert.equal(cancelDraftBody.version.source, "printer-apply");

    const afterCancel = await db.prepare(
      `SELECT r.pending_files_json,
              (SELECT COUNT(*) FROM repository_versions rv WHERE rv.repository_id = r.id) AS version_count
       FROM repositories r WHERE r.id = ?`,
    )
      .bind(repositoryId)
      .first();
    assert.equal(afterCancel.pending_files_json, null);
    assert.equal(afterCancel.version_count, 2);

    // Once that template is the applied immutable version, an old printer
    // capture can preserve its variables without trusting a desired baseline.
    // Unrelated printer-side edits remain literal in the new capture.
    const renderedPrinterEdit = newerFiles.map((file) => ({
      ...file,
      content: file.content
        .replace("${KLIPPEE:beacon_serial}", "/dev/serial/by-id/beacon-profile")
        .replace("max_velocity: 350", "max_velocity: 351"),
    }));
    const printerCapture = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        files: renderedPrinterEdit,
        message: "Legacy printer capture without sidecar",
        protocolVersion: 2,
      }),
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const printerCaptureBody = await printerCapture.json();
    assert.equal(printerCapture.status, 201);
    assert.match(printerCaptureBody.version.files[0].content, /\$\{KLIPPEE:beacon_serial\}/);
    assert.match(printerCaptureBody.version.files[0].content, /max_velocity: 351/);

    // A missing sidecar must never upload a host-local value that the server
    // cannot prove and convert back to its authoritative placeholder.
    const hostLocalTemplateFiles = printerCaptureBody.version.files.map((file) => ({
      ...file,
      content: `${file.content}endpoint: \${KLIPPEE:auth_token}\n`,
    }));
    const stageHostLocalTemplate = await dispatch(`/api/repos/${repositoryId}/pending`, {
      body: JSON.stringify({
        baseRevision: printerCaptureBody.version.revision,
        files: hostLocalTemplateFiles,
      }),
      headers: sessionHeaders,
      method: "PUT",
    });
    const stageHostLocalTemplateBody = await stageHostLocalTemplate.json();
    assert.equal(stageHostLocalTemplate.status, 200);

    const unsafeHostLocalCapture = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        baseRevision: stageHostLocalTemplateBody.desired.revision,
        files: hostLocalTemplateFiles.map((file) => ({
          ...file,
          content: file.content.replace("${KLIPPEE:auth_token}", "opaque-host-value"),
        })),
        message: "Missing template sidecar",
        protocolVersion: 2,
      }),
      headers: {
        authorization: `Bearer ${desktopTokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const unsafeHostLocalCaptureBody = await unsafeHostLocalCapture.json();
    assert.equal(unsafeHostLocalCapture.status, 422, JSON.stringify(unsafeHostLocalCaptureBody));
    assert.equal(unsafeHostLocalCaptureBody.code, "variable_template_sidecar_required");
    assert.deepEqual(unsafeHostLocalCaptureBody.variables, ["auth_token"]);
  });

  it("rejects a first rendered capture until the printer proves its desired baseline", async () => {
    const sessionHeaders = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const createRepo = await dispatch("/api/repos", {
      body: JSON.stringify({ empty: true, name: "first-variable-capture", title: "First variable capture" }),
      headers: sessionHeaders,
      method: "POST",
    });
    const repositoryId = (await createRepo.json()).repository.id;
    assert.equal(createRepo.status, 201);

    const createPrinter = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_first_variable_capture",
          name: "First variable capture printer",
          repositoryId,
          variableValues: { beacon_serial: "/dev/serial/by-id/first-capture-beacon" },
        },
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    assert.equal(createPrinter.status, 201);

    const createToken = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      body: JSON.stringify({
        name: "First variable capture token",
        printerId: "printer_first_variable_capture",
        scopes: ["repo:read", "repo:write"],
      }),
      headers: sessionHeaders,
      method: "POST",
    });
    const token = (await createToken.json()).token;
    assert.equal(createToken.status, 201);

    const desiredFiles = [{
      content: "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
      path: "beacon.cfg",
      public: false,
      role: "include",
    }];
    const stage = await dispatch(`/api/repos/${repositoryId}/pending`, {
      body: JSON.stringify({ baseRevision: null, files: desiredFiles }),
      headers: sessionHeaders,
      method: "PUT",
    });
    const staged = await stage.json();
    assert.equal(stage.status, 200);

    const renderedFiles = desiredFiles.map((file) => ({
      ...file,
      content: file.content.replace(
        "${KLIPPEE:beacon_serial}",
        "/dev/serial/by-id/first-capture-beacon",
      ),
    }));
    const unprovenCapture = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({ files: renderedFiles, protocolVersion: 2 }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const unprovenBody = await unprovenCapture.json();
    assert.equal(unprovenCapture.status, 422);
    assert.equal(unprovenBody.code, "variable_template_sidecar_required");
    assert.deepEqual(unprovenBody.variables, ["beacon_serial"]);

    const provenCapture = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        baseRevision: staged.desired.revision,
        files: renderedFiles,
        protocolVersion: 2,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const provenBody = await provenCapture.json();
    assert.equal(provenCapture.status, 201, JSON.stringify(provenBody));
    assert.match(provenBody.version.files[0].content, /\$\{KLIPPEE:beacon_serial\}/);
  });

  it("serves printer-bound sync status from the latest version", async () => {
    const response = await dispatch("/api/sync/repos/repo_1/status.txt", {
      headers: {
        authorization: "Bearer klp_printer_token",
      },
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /^printer_id=printer_1$/m);
    assert.match(body, /^applied_version=0$/m);
    assert.match(body, /^target_version=1$/m);
    assert.match(body, /^target_id=version_1$/m);
    assert.match(body, /^target_pending=0$/m);
    assert.match(body, /^target_source=web-editor$/m);
  });

  it("keeps stored sync metadata from breaking out of generated shell heredocs", async () => {
    const headers = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const files = [{
      content: "[printer]\nkinematics: cartesian\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }];
    const createdRepository = await dispatch("/api/repos", {
      body: JSON.stringify({ files, title: "Snapshot injection fixture" }),
      headers,
      method: "POST",
    });
    const createdRepositoryBody = await createdRepository.json();
    const repositoryId = createdRepositoryBody.repository.id;
    assert.equal(createdRepository.status, 201);

    const sourceInjection = "web-editor\nKLIPPEE_SYNC\ntouch /tmp/klippee-source-owned\n#";
    const createdVersion = await dispatch(`/api/repos/${repositoryId}/versions`, {
      body: JSON.stringify({
        files: [{ ...files[0], content: `${files[0].content}# second version\n` }],
        source: sourceInjection,
      }),
      headers,
      method: "POST",
    });
    assert.equal(createdVersion.status, 201);

    const printerId = "printer-shell-injection";
    const printerName = "Snapshot injection printer\nKLIPPEE_SYNC\ntouch /tmp/klippee-printer-owned\n#";
    const createdPrinter = await dispatch("/api/printers", {
      body: JSON.stringify({ printer: { id: printerId, name: printerName, repositoryId } }),
      headers,
      method: "POST",
    });
    assert.equal(createdPrinter.status, 201);

    const createdToken = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      body: JSON.stringify({ name: "Snapshot injection token", printerId, scopes: ["repo:read"] }),
      headers,
      method: "POST",
    });
    const createdTokenBody = await createdToken.json();
    assert.equal(createdToken.status, 201);

    const snapshot = await dispatch(`/api/sync/repos/${repositoryId}/snapshot.sh`, {
      headers: { authorization: `Bearer ${createdTokenBody.token}` },
    });
    const script = await snapshot.text();
    assert.equal(snapshot.status, 200);
    assert.equal(script.includes("\nKLIPPEE_SYNC\ntouch /tmp/klippee-source-owned"), false);
    assert.equal(/^touch \/tmp\/klippee-(?:source|printer)-owned$/m.test(script), false);
    assert.match(script, /^printer_id=printer-shell-injection$/m);
    assert.match(script, /^source=web-editor KLIPPEE_SYNC touch \/tmp\/klippee-source-owned #$/m);
    assert.equal((script.match(/^KLIPPEE_SYNC$/gm) ?? []).length, 1);

    const status = await dispatch(`/api/sync/repos/${repositoryId}/status.txt`, {
      headers: { authorization: `Bearer ${createdTokenBody.token}` },
    });
    const statusText = await status.text();
    assert.equal(status.status, 200);
    assert.equal(/^touch \/tmp\/klippee-(?:source|printer)-owned$/m.test(statusText), false);
    assert.match(
      statusText,
      /^printer_name=Snapshot injection printer KLIPPEE_SYNC touch \/tmp\/klippee-printer-owned #$/m,
    );
  });

  it("bounds sync-token names by UTF-8 bytes before storing them", async () => {
    const before = await db.prepare(
      "SELECT COUNT(*) AS count FROM sync_tokens WHERE repository_id = 'repo_1' AND user_id = 'user_1'",
    ).first();
    const response = await dispatch("/api/repos/repo_1/sync-tokens", {
      body: JSON.stringify({ name: "é".repeat(65) }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Sync token name must be at most 128 UTF-8 bytes",
    });
    const after = await db.prepare(
      "SELECT COUNT(*) AS count FROM sync_tokens WHERE repository_id = 'repo_1' AND user_id = 'user_1'",
    ).first();
    assert.equal(after.count, before.count);
  });

  it("debounces sync-token activity writes", async () => {
    const recentTimestamp = new Date().toISOString();
    await db.prepare("UPDATE sync_tokens SET last_used_at = ? WHERE id = 'sync_token_repo'")
      .bind(recentTimestamp)
      .run();

    const recentRequest = await dispatch("/api/sync/repos/repo_1/status.txt", {
      headers: { authorization: "Bearer klp_repo_token" },
    });
    await recentRequest.text();
    const unchanged = await db.prepare(
      "SELECT last_used_at FROM sync_tokens WHERE id = 'sync_token_repo'",
    ).first();
    assert.equal(recentRequest.status, 200);
    assert.equal(unchanged.last_used_at, recentTimestamp);

    await db.prepare(
      "UPDATE sync_tokens SET last_used_at = '2000-01-01T00:00:00.000Z' WHERE id = 'sync_token_repo'",
    ).run();
    const staleRequest = await dispatch("/api/sync/repos/repo_1/status.txt", {
      headers: { authorization: "Bearer klp_repo_token" },
    });
    await staleRequest.text();
    const refreshed = await db.prepare(
      "SELECT last_used_at FROM sync_tokens WHERE id = 'sync_token_repo'",
    ).first();
    assert.equal(staleRequest.status, 200);
    assert.notEqual(refreshed.last_used_at, "2000-01-01T00:00:00.000Z");

    const immediateRepeat = await dispatch("/api/sync/repos/repo_1/status.txt", {
      headers: { authorization: "Bearer klp_repo_token" },
    });
    await immediateRepeat.text();
    const stillDebounced = await db.prepare(
      "SELECT last_used_at FROM sync_tokens WHERE id = 'sync_token_repo'",
    ).first();
    assert.equal(immediateRepeat.status, 200);
    assert.equal(stillDebounced.last_used_at, refreshed.last_used_at);
  });

  it("requires a printer-bound sync token before marking a version applied", async () => {
    const response = await dispatch("/api/sync/repos/repo_1/applied", {
      body: JSON.stringify({ versionNumber: 1 }),
      headers: {
        authorization: "Bearer klp_repo_token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.json();
    const printer = await db.prepare("SELECT applied_version_id, applied_at FROM printers WHERE id = ?")
      .bind("printer_1")
      .first();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Printer-bound sync token required" });
    assert.equal(printer.applied_version_id, 0);
  });

  it("stores host info and repairs legacy repository-only printer tokens", async () => {
    const unbound = await dispatch("/api/sync/repos/repo_1/host-info", {
      body: JSON.stringify({ hostInfo: { os: "Debian GNU/Linux 12" } }),
      headers: {
        authorization: "Bearer klp_repo_token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal(unbound.status, 200);
    assert.equal((await unbound.json()).ok, true);
    const repairedToken = await db.prepare("SELECT printer_id FROM sync_tokens WHERE id = ?")
      .bind("sync_token_repo")
      .first();
    assert.equal(repairedToken.printer_id, "printer_1");

    const invalid = await dispatch("/api/sync/repos/repo_1/host-info", {
      body: JSON.stringify({ hostInfo: "not-an-object" }),
      headers: {
        authorization: "Bearer klp_printer_token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal(invalid.status, 400);

    const report = await dispatch("/api/sync/repos/repo_1/host-info", {
      body: JSON.stringify({
        hostInfo: {
          arch: "aarch64",
          cliVersion: "2026.07.22",
          ignoredField: "dropped",
          kernel: "5.10.110",
          klipperVersion: "v0.13.0-296-g12345678",
          klippyState: "ready",
          moonrakerVersion: "v0.9.3-64",
          nested: { not: "a string" },
          os: `Debian GNU/Linux 12 (bookworm)${"x".repeat(400)}`,
        },
      }),
      headers: {
        authorization: "Bearer klp_printer_token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const reportBody = await report.json();
    assert.equal(report.status, 200);
    assert.equal(reportBody.ok, true);
    assert.equal(reportBody.hostInfo.ignoredField, undefined);
    assert.equal(reportBody.hostInfo.nested, undefined);
    assert.equal(reportBody.hostInfo.kernel, "5.10.110");
    assert.equal(reportBody.hostInfo.os.length, 120);

    const printers = await dispatch("/api/printers", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const printersBody = await printers.json();
    const printer = printersBody.printers.find((candidate) => candidate.id === "printer_1");
    assert.equal(printer.hostInfo.klipperVersion, "v0.13.0-296-g12345678");
    assert.equal(printer.hostInfo.moonrakerVersion, "v0.9.3-64");
    assert.ok(printer.hostInfoUpdatedAt);
    await db.prepare("UPDATE sync_tokens SET printer_id = NULL WHERE id = ?")
      .bind("sync_token_repo")
      .run();
  });

  it("explains sync pushes that exceed the payload limits", async () => {
    const tooMany = await dispatch("/api/sync/repos/repo_1/push", {
      body: JSON.stringify({
        files: Array.from({ length: 65 }, (_, index) => ({
          content: "[bulk]\n",
          path: `bulk-${index}.cfg`,
          public: false,
          role: "include",
        })),
      }),
      headers: {
        authorization: "Bearer klp_repo_token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const tooManyBody = await tooMany.json();
    assert.equal(tooMany.status, 400);
    assert.match(tooManyBody.error, /Too many files: 65 exceeds the 64-file limit/);

    const oversized = await dispatch("/api/sync/repos/repo_1/push", {
      body: JSON.stringify({
        files: [{
          content: "x".repeat(256_001),
          path: "big.cfg",
          public: false,
          role: "include",
        }],
      }),
      headers: {
        authorization: "Bearer klp_repo_token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const oversizedBody = await oversized.json();
    assert.equal(oversized.status, 400);
    assert.match(oversizedBody.error, /File too large: big\.cfg/);
  });

  it("marks only the bound printer as applied", async () => {
    const response = await dispatch("/api/sync/repos/repo_1/applied", {
      body: JSON.stringify({ versionNumber: 1 }),
      headers: {
        authorization: "Bearer klp_printer_token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.json();
    const printer = await db.prepare("SELECT applied_version_id, applied_at FROM printers WHERE id = ?")
      .bind("printer_1")
      .first();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.appliedVersion.version_number, 1);
    assert.match(body.appliedVersion.revision, /^sha256:/);
    assert.equal(body.desiredChanged, false);
    assert.equal(printer.applied_version_id, 1);
    assert.equal(typeof printer.applied_at, "string");
  });
});
