import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  SESSION_TOKEN,
  STORAGE_LIMITS,
  WORKER_ORIGIN,
  bootSharedWorker,
  db,
  dispatch,
  disposeSharedWorker,
  mf,
} from "./helpers.mjs";

describe("worker API smoke: printers", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("rejects printer bindings to repositories owned by another user", async () => {
    const response = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "printer_cross_tenant",
          name: "Cross tenant printer",
          repositoryId: "repo_other",
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const body = await response.json();
    const printer = await db.prepare("SELECT id FROM printers WHERE id = ?")
      .bind("printer_cross_tenant")
      .first();

    assert.equal(response.status, 404);
    assert.deepEqual(body, { error: "Repository not found" });
    assert.equal(printer, null);
  });

  it("bounds R2-safe printer IDs and installed-version printer names by UTF-8 bytes", async () => {
    const headers = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const printerCountBefore = await db.prepare(
      "SELECT COUNT(*) AS count FROM printers WHERE user_id = 'user_1'",
    ).first();
    const invalidIds = [
      "p".repeat(STORAGE_LIMITS.printerIdBytes + 1),
      "printer/diagnostic-key-escape",
      "\u00e9".repeat(64),
    ];
    for (const id of invalidIds) {
      const response = await dispatch("/api/printers", {
        body: JSON.stringify({ printer: { id, name: "Invalid printer ID fixture" } }),
        headers,
        method: "POST",
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: `Printer ID must start with a letter or number and be at most ${STORAGE_LIMITS.printerIdBytes} UTF-8 bytes using only ASCII letters, numbers, dots, underscores, or hyphens`,
      });
    }

    const oversizedName = "\u00e9".repeat((STORAGE_LIMITS.printerNameBytes / 2) + 1);
    const rejectedName = await dispatch("/api/printers", {
      body: JSON.stringify({ printer: { id: "printer-name-too-large", name: oversizedName } }),
      headers,
      method: "POST",
    });
    assert.equal(rejectedName.status, 400);
    assert.deepEqual(await rejectedName.json(), {
      error: `Printer name must be at most ${STORAGE_LIMITS.printerNameBytes} UTF-8 bytes`,
    });
    const printerCountAfterRejections = await db.prepare(
      "SELECT COUNT(*) AS count FROM printers WHERE user_id = 'user_1'",
    ).first();
    assert.equal(printerCountAfterRejections.count, printerCountBefore.count);

    const files = [{
      content: "[printer]\nkinematics: cartesian\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }];
    const createdRepository = await dispatch("/api/repos", {
      body: JSON.stringify({ files, title: "Printer metadata boundary" }),
      headers,
      method: "POST",
    });
    const createdRepositoryBody = await createdRepository.json();
    assert.equal(createdRepository.status, 201);
    const repositoryId = createdRepositoryBody.repository.id;
    const printerId = "p".repeat(STORAGE_LIMITS.printerIdBytes);
    const printerName = "\u00e9".repeat(STORAGE_LIMITS.printerNameBytes / 2);
    const createdPrinter = await dispatch("/api/printers", {
      body: JSON.stringify({ printer: { id: printerId, name: printerName, repositoryId } }),
      headers,
      method: "POST",
    });
    assert.equal(createdPrinter.status, 201);

    const createdToken = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      body: JSON.stringify({ name: "Printer metadata apply token", printerId, scopes: ["repo:write"] }),
      headers,
      method: "POST",
    });
    const createdTokenBody = await createdToken.json();
    assert.equal(createdToken.status, 201);
    const appliedFiles = [{ ...files[0], content: `${files[0].content}# installed boundary\n` }];
    const applied = await dispatch(`/api/sync/repos/${repositoryId}/applied`, {
      body: JSON.stringify({ files: appliedFiles, protocolVersion: 2 }),
      headers: {
        authorization: `Bearer ${createdTokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal(applied.status, 200);
    const installedVersion = await db.prepare(
      `SELECT message
       FROM repository_versions
       WHERE repository_id = ? AND source = 'printer-apply'
       ORDER BY version_number DESC
       LIMIT 1`,
    ).bind(repositoryId).first();
    assert.equal(installedVersion.message, `Installed on ${printerName}`);
    assert.equal(new TextEncoder().encode(installedVersion.message).byteLength <= 512, true);

    const generatedPrinter = await dispatch("/api/printers", {
      body: JSON.stringify({ printer: { name: "Generated ID boundary printer" } }),
      headers,
      method: "POST",
    });
    const generatedPrinterBody = await generatedPrinter.json();
    assert.equal(generatedPrinter.status, 201);
    assert.match(generatedPrinterBody.printer.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.equal(
      new TextEncoder().encode(generatedPrinterBody.printer.id).byteLength <= STORAGE_LIMITS.printerIdBytes,
      true,
    );

    await db.batch([
      db.prepare("DELETE FROM printers WHERE id IN (?, ?) AND user_id = 'user_1'")
        .bind(printerId, generatedPrinterBody.printer.id),
      db.prepare("DELETE FROM repositories WHERE id = ? AND user_id = 'user_1'").bind(repositoryId),
    ]);
  });

  it("keeps applied pointers server-owned and clears them when a printer changes repositories", async () => {
    const headers = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const files = [{ content: "[printer]\nkinematics: corexy\n", path: "printer.cfg", public: false, role: "printer" }];
    const createRepository = async (title) => {
      const response = await dispatch("/api/repos", {
        body: JSON.stringify({ files, title }),
        headers,
        method: "POST",
      });
      const body = await response.json();
      assert.equal(response.status, 201);
      return body.repository.id;
    };
    const firstRepositoryId = await createRepository("Pointer source");
    const secondRepositoryId = await createRepository("Pointer destination");
    const printerId = "printer_server_owned_pointers";

    const createPrinter = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          appliedVersionId: 999,
          id: printerId,
          latestVersionId: 999,
          name: "Pointer printer",
          repositoryId: firstRepositoryId,
        },
      }),
      headers,
      method: "POST",
    });
    const createdPrinter = (await createPrinter.json()).printer;
    assert.equal(createPrinter.status, 201);
    assert.equal(createdPrinter.appliedVersionId, 0);
    assert.equal(createdPrinter.latestVersionId, 0);

    const createToken = await dispatch(`/api/repos/${firstRepositoryId}/sync-tokens`, {
      body: JSON.stringify({ name: "Pointer printer token", printerId, scopes: ["repo:read", "repo:write"] }),
      headers,
      method: "POST",
    });
    const token = await createToken.json();
    assert.equal(createToken.status, 201);
    const apply = await dispatch(`/api/sync/repos/${firstRepositoryId}/applied`, {
      body: JSON.stringify({ versionNumber: 1 }),
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(apply.status, 200);

    const rebind = await dispatch("/api/printers", {
      body: JSON.stringify({
        printer: {
          appliedVersionId: 999,
          id: printerId,
          latestVersionId: 999,
          name: "Pointer printer",
          repositoryId: secondRepositoryId,
        },
      }),
      headers,
      method: "POST",
    });
    const reboundPrinter = (await rebind.json()).printer;
    assert.equal(rebind.status, 200);
    assert.equal(reboundPrinter.appliedAt, null);
    assert.equal(reboundPrinter.appliedVersionId, 0);
    assert.equal(reboundPrinter.latestVersionId, 0);

    const staleApply = await dispatch(`/api/sync/repos/${firstRepositoryId}/applied`, {
      body: JSON.stringify({ versionNumber: 1 }),
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(staleApply.status, 400);
    assert.equal((await staleApply.json()).error, "Printer-bound sync token required");
  });

  it("links an existing printer and records its first safe snapshot as the baseline", async () => {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO printers
       (id, user_id, name, description, make, model, source, definition_json, package_ids_json, variable_values_json,
        repository_id, latest_version_id, applied_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("printer_import", "user_1", "Import printer", "", "", "", "manual", "{}", "[]", "{}", null, 0, 0, now, now)
      .run();

    const createRepo = await dispatch("/api/repos", {
      body: JSON.stringify({ empty: true, name: "import-printer", title: "Import printer" }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const repoBody = await createRepo.json();
    assert.equal(createRepo.status, 201);
    assert.equal(repoBody.version, null);
    const repositoryId = repoBody.repository.id;

    const createToken = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      body: JSON.stringify({
        name: "Import token",
        printerId: "printer_import",
        scopes: ["repo:read", "repo:write"],
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const tokenBody = await createToken.json();
    assert.equal(createToken.status, 201);

    const push = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        files: [{
          content: "[printer]\nkinematics: corexy\n",
          path: "printer.cfg",
          public: false,
          role: "entrypoint",
        }],
        message: "Initial import from printer",
      }),
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const pushBody = await push.json();
    assert.equal(push.status, 201);
    assert.equal(pushBody.version.version_number, 1);

    const unchangedPush = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        files: [{
          content: "[printer]\nkinematics: corexy\n",
          path: "printer.cfg",
          public: false,
          role: "include",
        }],
        message: "Same contents, different message and metadata",
      }),
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const unchangedPushBody = await unchangedPush.json();
    assert.equal(unchangedPush.status, 200);
    assert.equal(unchangedPushBody.unchanged, true);
    assert.equal(unchangedPushBody.version.version_number, 1);
    const versionCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM repository_versions WHERE repository_id = ?",
    )
      .bind(repositoryId)
      .first();
    assert.equal(versionCount.count, 1);

    const printer = await db.prepare(
      `SELECT repository_id, latest_version_id, applied_version_id, applied_at
       FROM printers WHERE id = ?`,
    )
      .bind("printer_import")
      .first();
    assert.equal(printer.applied_version_id, 1);
    assert.equal(printer.latest_version_id, 1);
    assert.equal(printer.repository_id, repositoryId);
    assert.equal(typeof printer.applied_at, "string");

    const rejectedPush = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        files: [{ content: "token: private-value\n", path: "saved_variables.cfg", public: false, role: "include" }],
      }),
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const rejectedBody = await rejectedPush.json();
    assert.equal(rejectedPush.status, 422);
    assert.deepEqual(rejectedBody.rejectedPaths, ["saved_variables.cfg"]);

    const createDesktopToken = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      body: JSON.stringify({
        clientMode: "desktop",
        name: "Import printer desktop sync token",
        printerId: "printer_import",
        scopes: ["repo:read", "repo:write"],
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const desktopTokenBody = await createDesktopToken.json();
    assert.equal(createDesktopToken.status, 201);
    assert.ok(desktopTokenBody.tokenRecord.scopes.includes("client:desktop"));

    const desktopFiles = [{
      content: "[printer]\nkinematics: corexy\nmax_velocity: 300\n",
      path: "printer.cfg",
      public: false,
      role: "entrypoint",
    }];
    const bucket = await mf.getR2Bucket("BLOBS");
    const blobKeysBeforeDesktopDrafts = (await bucket.list({ prefix: "blobs/sha256/" }))
      .objects.map((object) => object.key)
      .sort();
    const desktopPush = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        baseRevision: pushBody.version.revision,
        clientMode: "desktop",
        files: desktopFiles,
        message: "Edited on desktop",
        protocolVersion: 2,
      }),
      headers: {
        authorization: `Bearer ${desktopTokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const desktopPushBody = await desktopPush.json();
    assert.equal(desktopPush.status, 202);
    assert.equal(desktopPushBody.staged, true);
    assert.equal(desktopPushBody.version.source, "pending");
    assert.equal(desktopPushBody.version.version_number, 2);

    const desktopApplied = await dispatch(`/api/sync/repos/${repositoryId}/applied`, {
      body: JSON.stringify({ versionNumber: 2 }),
      headers: {
        authorization: `Bearer ${desktopTokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const afterDesktopPush = await db.prepare(
      "SELECT applied_version_id FROM printers WHERE id = ?",
    )
      .bind("printer_import")
      .first();
    assert.equal(desktopApplied.status, 403);
    assert.equal(afterDesktopPush.applied_version_id, 1);

    const nextDesktopFiles = [{
      content: "[printer]\nkinematics: corexy\nmax_velocity: 301\n",
      path: "printer.cfg",
      public: false,
      role: "entrypoint",
    }];
    const staleDesktopPush = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        baseRevision: pushBody.version.revision,
        files: nextDesktopFiles,
        message: "Stale desktop edit",
        protocolVersion: 2,
      }),
      headers: {
        authorization: `Bearer ${desktopTokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const staleDesktopPushBody = await staleDesktopPush.json();
    assert.equal(staleDesktopPush.status, 409);
    assert.equal(staleDesktopPushBody.code, "desired_configuration_conflict");

    const nextDesktopPush = await dispatch(`/api/sync/repos/${repositoryId}/push`, {
      body: JSON.stringify({
        baseRevision: desktopPushBody.version.revision,
        files: nextDesktopFiles,
        message: "Edited again on desktop",
        protocolVersion: 2,
      }),
      headers: {
        authorization: `Bearer ${desktopTokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const nextDesktopPushBody = await nextDesktopPush.json();
    const afterDesktopDrafts = await db.prepare(
      `SELECT printers.applied_version_id, repositories.pending_files_json
       FROM printers
       JOIN repositories ON repositories.id = printers.repository_id
       WHERE printers.id = ?`,
    )
      .bind("printer_import")
      .first();
    const blobKeysAfterDesktopDrafts = (await bucket.list({ prefix: "blobs/sha256/" }))
      .objects.map((object) => object.key)
      .sort();
    assert.equal(nextDesktopPush.status, 202);
    assert.equal(afterDesktopDrafts.applied_version_id, 1);
    assert.equal(Array.isArray(JSON.parse(afterDesktopDrafts.pending_files_json)), true);
    assert.deepEqual(blobKeysAfterDesktopDrafts, blobKeysBeforeDesktopDrafts);

    const applyDesktopDraft = await dispatch(`/api/sync/repos/${repositoryId}/applied`, {
      body: JSON.stringify({
        desiredRevision: nextDesktopPushBody.version.revision,
        files: nextDesktopFiles,
        protocolVersion: 2,
        versionNumber: 2,
      }),
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const applyDesktopDraftBody = await applyDesktopDraft.json();
    assert.equal(applyDesktopDraft.status, 200);
    assert.equal(applyDesktopDraftBody.appliedVersion.version_number, 2);

    const versionList = await dispatch(`/api/sync/repos/${repositoryId}/versions`, {
      headers: { authorization: `Bearer ${tokenBody.token}` },
    });
    const versionListBody = await versionList.json();
    assert.equal(versionList.status, 200);
    assert.deepEqual(
      versionListBody.versions.map((version) => version.version_number),
      [2, 1],
    );
    assert.equal("files" in versionListBody.versions[0], false);

    const rollback = await dispatch(`/api/sync/repos/${repositoryId}/rollback`, {
      body: JSON.stringify({ versionNumber: 1 }),
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const rollbackBody = await rollback.json();
    assert.equal(rollback.status, 201);
    assert.equal(rollbackBody.sourceVersionNumber, 1);
    assert.equal(rollbackBody.version.version_number, 3);
    assert.equal(rollbackBody.version.source, "recovery");

    const pullLatest = await dispatch(`/api/sync/repos/${repositoryId}/pull?version=2`, {
      headers: { authorization: `Bearer ${tokenBody.token}` },
    });
    const pullLatestBody = await pullLatest.json();
    assert.equal(pullLatest.status, 200);
    assert.equal(pullLatestBody.version.version_number, 3);
    assert.match(pullLatestBody.version.files[0].content, /kinematics: corexy/);
    assert.doesNotMatch(pullLatestBody.version.files[0].content, /max_velocity/);

    const markLatestApplied = await dispatch(`/api/sync/repos/${repositoryId}/applied`, {
      body: JSON.stringify({ versionNumber: 3 }),
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const markLatestAppliedBody = await markLatestApplied.json();
    assert.equal(markLatestApplied.status, 200);
    assert.equal(markLatestAppliedBody.appliedVersion.version_number, 3);
  });
});
