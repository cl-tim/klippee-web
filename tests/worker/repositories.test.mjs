import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  SESSION_TOKEN,
  STORAGE_MAINTENANCE_TOKEN,
  WORKER_ORIGIN,
  bootSharedWorker,
  db,
  dispatch,
  disposeSharedWorker,
  mf,
  sha256Hex,
} from "./helpers.mjs";

describe("worker API smoke: repositories", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("restores one repository file from history by creating a new latest version", async () => {
    const createVersion = await dispatch("/api/repos/repo_1/versions", {
      body: JSON.stringify({
        files: [
          {
            content: "[printer]\nkinematics: corexy\n",
            path: "printer.cfg",
            public: false,
            role: "printer",
          },
          {
            content: "[gcode_macro TEST]\ngcode: M117 changed\n",
            path: "macros.cfg",
            public: false,
            role: "macro",
          },
        ],
        message: "Change printer and macros",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const createBody = await createVersion.json();

    assert.equal(createVersion.status, 201);
    assert.equal(createBody.version.version_number, 2);

    const restore = await dispatch("/api/repos/repo_1/restore-file", {
      body: JSON.stringify({
        path: "printer.cfg",
        sourceVersionNumber: 1,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const restoreBody = await restore.json();
    const files = restoreBody.version.files;

    assert.equal(restore.status, 201);
    assert.equal(restoreBody.restoredPath, "printer.cfg");
    assert.equal(restoreBody.sourceVersionNumber, 1);
    assert.equal(restoreBody.version.version_number, 3);
    assert.equal(restoreBody.version.source, "recovery");
    assert.equal(files.find((file) => file.path === "printer.cfg")?.content, "[printer]\nkinematics: cartesian\n");
    assert.equal(files.find((file) => file.path === "macros.cfg")?.content, "[gcode_macro TEST]\ngcode: M117 changed\n");

    const diff = await dispatch("/api/repos/repo_1/diff?from=2&to=3", {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      },
    });
    const diffBody = await diff.json();

    assert.equal(diff.status, 200);
    assert.equal(diffBody.files.some((file) => file.path === "printer.cfg"), true);
  });

  it("protects applied repository versions while repairing deletable history", async () => {
    const headers = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const baseFiles = [{ content: "[printer]\nkinematics: corexy\n", path: "printer.cfg", public: false, role: "printer" }];
    const create = await dispatch("/api/repos", {
      body: JSON.stringify({
        files: baseFiles,
        title: "Delete history repo",
      }),
      headers,
      method: "POST",
    });
    const created = await create.json();
    const repoId = created.repository.id;
    const version1Id = created.version.id;

    const version2Response = await dispatch(`/api/repos/${repoId}/versions`, {
      body: JSON.stringify({ files: baseFiles, message: "Duplicate snapshot" }),
      headers,
      method: "POST",
    });
    const version2 = (await version2Response.json()).version;
    const version3Response = await dispatch(`/api/repos/${repoId}/versions`, {
      body: JSON.stringify({
        files: [{ content: "[printer]\nkinematics: corexy\n# changed\n", path: "printer.cfg", public: false, role: "printer" }],
        message: "Changed snapshot",
      }),
      headers,
      method: "POST",
    });
    const version3 = (await version3Response.json()).version;
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO printers
       (id, user_id, name, description, make, model, source, definition_json, package_ids_json, variable_values_json,
        repository_id, latest_version_id, applied_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("printer_delete_history", "user_1", "Delete history printer", "", "", "", "manual", "{}", "[]", "{}", repoId, 3, 2, now, now).run();

    const middleDelete = await dispatch(`/api/repos/${repoId}/versions/2`, { headers, method: "DELETE" });
    const middleBody = await middleDelete.json();
    assert.equal(middleDelete.status, 409);
    assert.equal(middleBody.error, "The last confirmed printer configuration cannot be deleted");

    const latestDelete = await dispatch(`/api/repos/${repoId}/versions/3`, { headers, method: "DELETE" });
    const latestBody = await latestDelete.json();
    assert.equal(latestDelete.status, 200);
    assert.equal(latestBody.latestVersion.version_number, 2);
    assert.equal(latestBody.printer.latest_version_id, 2);
    assert.equal(latestBody.printer.applied_version_id, 2);

    const firstDelete = await dispatch(`/api/repos/${repoId}/versions/1`, { headers, method: "DELETE" });
    const firstBody = await firstDelete.json();
    assert.equal(firstDelete.status, 200);
    assert.equal(firstBody.latestVersion.version_number, 2);
    const repairedVersion2 = await db.prepare("SELECT previous_version_id FROM repository_versions WHERE id = ?")
      .bind(version2.id)
      .first();
    assert.equal(repairedVersion2.previous_version_id, null);

    const finalDelete = await dispatch(`/api/repos/${repoId}/versions/2`, { headers, method: "DELETE" });
    assert.equal(finalDelete.status, 409);
    assert.equal((await finalDelete.json()).error, "A repository must keep at least one version");
    assert.equal(version1Id.length > 0, true);
    assert.equal(version3.version_number, 3);
    assert.equal(version2.version_number, 2);
  });

  it("serializes concurrent deletes so a repository always keeps one version", async () => {
    const headers = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const files = [{
      content: "[printer]\nkinematics: corexy\n# concurrent delete\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }];
    const createdResponse = await dispatch("/api/repos", {
      body: JSON.stringify({ files, title: "Concurrent deletion boundary" }),
      headers,
      method: "POST",
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    const repositoryId = created.repository.id;

    const secondVersionResponse = await dispatch(`/api/repos/${repositoryId}/versions`, {
      body: JSON.stringify({ files, message: "Second retained version" }),
      headers,
      method: "POST",
    });
    assert.equal(secondVersionResponse.status, 201);

    const responses = await Promise.all([
      dispatch(`/api/repos/${repositoryId}/versions/1`, { headers, method: "DELETE" }),
      dispatch(`/api/repos/${repositoryId}/versions/2`, { headers, method: "DELETE" }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const conflict = responses.find((response) => response.status === 409);
    assert.equal((await conflict.json()).error, "A repository must keep at least one version");

    const retained = await db.prepare(
      `SELECT rv.id, rv.previous_version_id, rv.version_number, r.latest_version_id
       FROM repositories r
       JOIN repository_versions rv ON rv.repository_id = r.id
       WHERE r.id = ?`,
    )
      .bind(repositoryId)
      .all();
    assert.equal(retained.results.length, 1);
    assert.equal(retained.results[0].latest_version_id, retained.results[0].id);
    assert.equal(retained.results[0].previous_version_id, null);
  });

  it("never applies a repository version that loses a concurrent delete", async () => {
    const ownerHeaders = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const firstFiles = [{
      content: `[printer]\nkinematics: corexy\n# ${"sync race ".repeat(12_000)}\n`,
      path: "printer.cfg",
      public: false,
      role: "printer",
    }];
    const createdResponse = await dispatch("/api/repos", {
      body: JSON.stringify({ files: firstFiles, title: "Apply deletion boundary" }),
      headers: ownerHeaders,
      method: "POST",
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    const repositoryId = created.repository.id;
    const firstVersionId = created.version.id;
    const secondVersionResponse = await dispatch(`/api/repos/${repositoryId}/versions`, {
      body: JSON.stringify({
        files: [{ content: "[printer]\nkinematics: corexy\n# second\n", path: "printer.cfg", public: false, role: "printer" }],
        message: "Keep one alternate version",
      }),
      headers: ownerHeaders,
      method: "POST",
    });
    assert.equal(secondVersionResponse.status, 201);

    const printerId = `printer_apply_delete_${crypto.randomUUID()}`;
    const printerResponse = await dispatch("/api/printers", {
      body: JSON.stringify({ printer: { id: printerId, name: "Apply/delete printer", repositoryId } }),
      headers: ownerHeaders,
      method: "POST",
    });
    assert.equal(printerResponse.status, 201);
    const tokenResponse = await dispatch(`/api/repos/${repositoryId}/sync-tokens`, {
      body: JSON.stringify({ name: "Apply/delete token", printerId, scopes: ["repo:read", "repo:write"] }),
      headers: ownerHeaders,
      method: "POST",
    });
    const token = await tokenResponse.json();
    assert.equal(tokenResponse.status, 201);

    const applyPromise = dispatch(`/api/sync/repos/${repositoryId}/applied`, {
      body: JSON.stringify({ versionNumber: 1 }),
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      method: "POST",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [applyResponse, deleteResponse] = await Promise.all([
      applyPromise,
      dispatch(`/api/repos/${repositoryId}/versions/1`, { headers: ownerHeaders, method: "DELETE" }),
    ]);
    assert.equal([200, 404, 409].includes(applyResponse.status), true);
    assert.equal([200, 409].includes(deleteResponse.status), true);

    const [target, printer] = await Promise.all([
      db.prepare("SELECT id FROM repository_versions WHERE id = ?").bind(firstVersionId).first(),
      db.prepare("SELECT applied_version_id FROM printers WHERE id = ?").bind(printerId).first(),
    ]);
    assert.equal(!(target === null && printer.applied_version_id === 1), true);
    if (applyResponse.status === 200) {
      assert.notEqual(target, null);
      assert.equal(deleteResponse.status, 409);
    }
  });

  it("stores repository files as content-addressed blobs and reconstructs them", async () => {
    const create = await dispatch("/api/repos", {
      body: JSON.stringify({
        files: [{ content: "[printer]\nkinematics: delta\n", path: "printer.cfg", public: false, role: "printer" }],
        title: "Blob repo",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const created = await create.json();
    assert.equal(create.status, 201);
    const repoId = created.repository.id;

    // The version manifest stored in D1 is a content-addressed tree, and the file
    // blob is written once to a global content-addressed key in R2.
    const row = await db.prepare("SELECT files_json FROM repository_versions WHERE id = ?")
      .bind(created.version.id)
      .first();
    const manifest = JSON.parse(row.files_json);
    assert.equal(manifest.storage, "r2-blobs");
    assert.equal(manifest.version, 2);
    assert.equal(manifest.entries.length, 1);
    const hash = manifest.entries[0].sha256;

    const bucket = await mf.getR2Bucket("BLOBS");
    assert.notEqual(await bucket.head(`blobs/sha256/${hash}`), null);

    // A new version that keeps printer.cfg unchanged reuses the same blob (dedup).
    const extraContent = `[gcode_macro NEW]\ngcode: M117 ${crypto.randomUUID()}\n`;
    const v2 = await dispatch(`/api/repos/${repoId}/versions`, {
      body: JSON.stringify({
        files: [
          { content: "[printer]\nkinematics: delta\n", path: "printer.cfg", public: false, role: "printer" },
          { content: extraContent, path: "extra.cfg", public: false, role: "macro" },
        ],
        message: "Add a file",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(v2.status, 201);
    const v2Body = await v2.json();
    assert.notEqual(await bucket.head(`blobs/sha256/${hash}`), null);
    const referenceState = await db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM canonical_blob_repository_version_refs WHERE sha256 = ?) AS reference_count,
         (SELECT COUNT(*) FROM canonical_blob_write_leases WHERE sha256 = ?) AS leases`,
    ).bind(hash, hash).first();
    assert.deepEqual(referenceState, { leases: 0, reference_count: 2 });

    // Listing versions reconstructs file content from the blobs.
    const list = await dispatch(`/api/repos/${repoId}/versions`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const listBody = await list.json();
    const firstVersion = listBody.versions.find((version) => version.version_number === 1);
    assert.equal(
      firstVersion.files.find((file) => file.path === "printer.cfg").content,
      "[printer]\nkinematics: delta\n",
    );

    const compactList = await dispatch(`/api/repos/${repoId}/versions?format=content-addressed`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const compactBody = await compactList.json();
    assert.equal(compactList.status, 200);
    assert.equal(compactBody.storageFormat, "content-addressed-v1");
    const compactV1 = compactBody.versions.find((version) => version.version_number === 1);
    const compactV2 = compactBody.versions.find((version) => version.version_number === 2);
    const v1Printer = compactV1.files.find((file) => file.path === "printer.cfg");
    const v2Printer = compactV2.files.find((file) => file.path === "printer.cfg");
    assert.equal(Object.hasOwn(v1Printer, "content"), false);
    assert.equal(v1Printer.sha256, v2Printer.sha256);
    assert.deepEqual(Object.keys(compactBody.blobs).sort(), [
      hash,
      await sha256Hex(extraContent),
    ].sort());
    assert.equal(compactBody.blobs[v1Printer.sha256], "[printer]\nkinematics: delta\n");

    await bucket.delete(`blobs/sha256/${hash}`);
    const operatorHeaders = { authorization: `Bearer ${STORAGE_MAINTENANCE_TOKEN}` };
    const malformedLedgerHash = "Z".repeat(64);
    const malformedLedgerAt = new Date().toISOString();
    await db.prepare(
      `INSERT INTO canonical_blobs
         (sha256, size_bytes, charge_bytes, created_at, stored_at)
       VALUES (?, 1, 65536, ?, ?)`,
    ).bind(malformedLedgerHash, malformedLedgerAt, malformedLedgerAt).run();
    const referencesResponse = await dispatch("/api/internal/storage/canonical-references", {
      headers: operatorHeaders,
    });
    const referenceInventory = (await referencesResponse.json()).references;
    const referencedBlob = referenceInventory.find((entry) => entry.sha256 === hash);
    assert.equal(referencedBlob.referenceCount, 2);
    assert.equal(referencedBlob.manifestReferenceCount, 2);
    const malformedLedger = referenceInventory.find((entry) => entry.sha256 === malformedLedgerHash);
    assert.equal(malformedLedger.ledgerPresent, true);
    assert.equal(malformedLedger.reclaimable, false);
    assert.equal(
      (await dispatch(
        `/api/internal/storage/canonical-references?after=${encodeURIComponent(malformedLedgerHash)}`,
        { headers: operatorHeaders },
      )).status,
      200,
    );
    await db.prepare("DELETE FROM canonical_blobs WHERE sha256 = ?").bind(malformedLedgerHash).run();
    const claimOnlyHash = await sha256Hex(`claim-only ${crypto.randomUUID()}`);
    await db.prepare(
      `INSERT INTO user_blob_claims
         (user_id, sha256, size_bytes, charge_bytes, created_at)
       VALUES ('user_1', ?, 1, 65536, ?)`,
    ).bind(claimOnlyHash, malformedLedgerAt).run();
    const claimOnlyInventory = await dispatch("/api/internal/storage/canonical-references", {
      headers: operatorHeaders,
    });
    const claimOnly = (await claimOnlyInventory.json()).references.find(
      (entry) => entry.sha256 === claimOnlyHash,
    );
    assert.equal(claimOnly.claimCount, 1);
    assert.equal(claimOnly.ledgerPresent, false);
    assert.equal(claimOnly.reclaimable, true);
    assert.equal(claimOnly.referenceCount, 0);
    const claimOnlyPlan = await dispatch("/api/internal/storage/reclaims", {
      body: JSON.stringify({ hashes: [claimOnlyHash] }),
      headers: { ...operatorHeaders, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal((await claimOnlyPlan.json()).results[0].status, "observing");
    await db.batch([
      db.prepare("DELETE FROM canonical_blob_gc_candidates WHERE sha256 = ?").bind(claimOnlyHash),
      db.prepare("DELETE FROM user_blob_claims WHERE sha256 = ?").bind(claimOnlyHash),
    ]);
    const objectsResponse = await dispatch("/api/internal/storage/objects", { headers: operatorHeaders });
    assert.equal((await objectsResponse.json()).objects.some((object) => object.key === `blobs/sha256/${hash}`), false);
    await bucket.put(`blobs/sha256/${hash}`, "[printer]\nkinematics: delta\n", {
      customMetadata: { sha256: hash },
    });

    // Reconciliation must retain a raw-manifest reference even if its
    // normalized/accounting rows have drifted away.
    const driftHash = await sha256Hex(extraContent);
    const driftKey = `blobs/sha256/${driftHash}`;
    const driftSize = new TextEncoder().encode(extraContent).byteLength;
    await bucket.delete(driftKey);
    await db.batch([
      db.prepare("DELETE FROM canonical_blob_repository_version_refs WHERE sha256 = ?").bind(driftHash),
      db.prepare("DELETE FROM user_blob_claims WHERE sha256 = ?").bind(driftHash),
      db.prepare("DELETE FROM canonical_blobs WHERE sha256 = ?").bind(driftHash),
    ]);
    const driftResponse = await dispatch("/api/internal/storage/canonical-references", {
      headers: operatorHeaders,
    });
    const driftReference = (await driftResponse.json()).references.find((entry) => entry.sha256 === driftHash);
    assert.deepEqual(driftReference, {
      activeLeaseCount: 0,
      chargeBytes: null,
      claimCount: 0,
      createdAt: null,
      ledgerPresent: false,
      manifestOnlyReferenceCount: 1,
      manifestReferenceCount: 1,
      normalizedOnlyReferenceCount: 0,
      ownerCount: 1,
      reclaimable: true,
      referenceCount: 0,
      sha256: driftHash,
      sizeBytes: null,
      storedAt: null,
    });
    const blockedDriftReclaim = await dispatch("/api/internal/storage/reclaims", {
      body: JSON.stringify({ hashes: [driftHash] }),
      headers: { ...operatorHeaders, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal((await blockedDriftReclaim.json()).results[0].status, "referenced");

    await bucket.put(driftKey, extraContent, { customMetadata: { sha256: driftHash } });
    const restoredAt = new Date().toISOString();
    await db.batch([
      db.prepare(
        `INSERT INTO canonical_blobs
           (sha256, size_bytes, charge_bytes, created_at, stored_at)
         VALUES (?, ?, 65536, ?, ?)`,
      ).bind(driftHash, driftSize, restoredAt, restoredAt),
      db.prepare(
        `INSERT INTO user_blob_claims
           (user_id, sha256, size_bytes, charge_bytes, created_at)
         VALUES ('user_1', ?, ?, 65536, ?)`,
      ).bind(driftHash, driftSize, restoredAt),
      db.prepare("UPDATE repository_versions SET files_json = files_json WHERE id = ?")
        .bind(v2Body.version.id),
    ]);
  });

  it("creates unique repository versions during concurrent saves", async () => {
    const create = await dispatch("/api/repos", {
      body: JSON.stringify({
        files: [{ content: "[printer]\nkinematics: cartesian\n", path: "printer.cfg", public: false, role: "printer" }],
        title: "Concurrent repo",
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const created = await create.json();
    assert.equal(create.status, 201);

    const saves = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        dispatch(`/api/repos/${created.repository.id}/versions`, {
          body: JSON.stringify({
            files: [
              {
                content: `[printer]\nkinematics: cartesian\n# concurrent ${index}\n`,
                path: "printer.cfg",
                public: false,
                role: "printer",
              },
            ],
            message: `Concurrent save ${index}`,
          }),
          headers: {
            cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
            "content-type": "application/json",
            origin: WORKER_ORIGIN,
          },
          method: "POST",
        }),
      ),
    );

    assert.deepEqual(saves.map((response) => response.status), [201, 201, 201, 201, 201, 201]);
    const storedVersions = await db.prepare(
      "SELECT version_number FROM repository_versions WHERE repository_id = ? ORDER BY version_number ASC",
    )
      .bind(created.repository.id)
      .all();
    assert.deepEqual(
      storedVersions.results.map((version) => version.version_number),
      [1, 2, 3, 4, 5, 6, 7],
    );

    const latest = await db.prepare("SELECT latest_version_id FROM repositories WHERE id = ?")
      .bind(created.repository.id)
      .first();
    const latestVersion = await db.prepare("SELECT version_number FROM repository_versions WHERE id = ?")
      .bind(latest.latest_version_id)
      .first();
    assert.equal(latestVersion.version_number, 7);
  });
});
