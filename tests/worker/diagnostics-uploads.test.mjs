import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { strToU8, unzipSync, zipSync } from "fflate";
import { Miniflare } from "./miniflare.mjs";
import {
  REVIEW_TOKEN,
  SECOND_SESSION_TOKEN,
  SESSION_SECRET,
  SESSION_TOKEN,
  WORKER_ORIGIN,
  applyMigrations,
  bootSharedWorker,
  db,
  dispatch,
  disposeSharedWorker,
  mf,
  sha256Hex,
} from "./helpers.mjs";

describe("worker API smoke: diagnostics-uploads", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("fails closed before storing an upload when its rate-limit binding is absent", async () => {
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: "http://localhost",
        LOCAL_AUTH_BYPASS: "1",
        LOG_IMPROVEMENT_REVIEW_TOKEN: REVIEW_TOKEN,
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-missing-upload-ratelimit-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-missing-upload-ratelimit-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const tempDb = await tempMf.getD1Database("DB");
      await applyMigrations(tempDb);
      const log = "redacted missing-binding fixture\n";
      const response = await tempMf.dispatchFetch("http://localhost/api/log-improvement-submissions", {
        body: log,
        headers: {
          "content-length": String(Buffer.byteLength(log)),
          "content-type": "text/plain",
          origin: "http://localhost",
          "x-klippee-consent-version": "2026-07-24",
          "x-klippee-redaction-confirmed": "1",
        },
        method: "POST",
      });
      const rows = await tempDb.prepare("SELECT COUNT(*) AS count FROM log_improvement_submissions").first();
      const objects = await (await tempMf.getR2Bucket("BLOBS")).list({ prefix: "diagnostic-improvements/" });

      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "60");
      assert.deepEqual(await response.json(), {
        code: "upload_rate_limit_unavailable",
        error: "Upload protection is temporarily unavailable. Retry shortly.",
        resource: "log-improvement-submissions",
        retryAfterSeconds: 60,
      });
      assert.equal(rows.count, 0);
      assert.equal(objects.objects.length, 0);
    } finally {
      await tempMf.dispose();
    }
  });

  it("stores private expiring printer diagnostics and only serves them to their owner", async () => {
    const log = "Stats 1.0: heater_bed: target=60 temp=55\nTransition to shutdown state: ADC out of range\n";
    const compressed = gzipSync(log);
    const uploadResponse = await dispatch("/api/sync/repos/repo_1/diagnostics", {
      body: compressed,
      headers: {
        authorization: "Bearer klp_printer_token",
        "content-length": String(compressed.byteLength),
        "content-type": "application/gzip",
        "x-klippee-log-name": "klippy.log.gz",
        "x-klippee-original-size": String(Buffer.byteLength(log)),
      },
      method: "POST",
    });
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadResponse.status, 201);
    assert.equal(uploadBody.upload.fileName, "klippy.log.gz");
    assert.equal(uploadBody.upload.printerId, "printer_1");
    assert.ok(
      Math.abs(
        new Date(uploadBody.upload.expiresAt).getTime()
        - new Date(uploadBody.upload.createdAt).getTime()
        - 48 * 60 * 60 * 1000,
      ) < 1_000,
    );
    assert.match(uploadBody.url, new RegExp(`/log-diagnostics\\?upload=${uploadBody.upload.id}$`));

    const unbound = await dispatch("/api/sync/repos/repo_1/diagnostics", {
      body: compressed,
      headers: {
        authorization: "Bearer klp_repo_token",
        "content-length": String(compressed.byteLength),
        "content-type": "application/gzip",
      },
      method: "POST",
    });
    assert.equal(unbound.status, 403);

    const invalid = await dispatch("/api/sync/repos/repo_1/diagnostics", {
      body: "not gzip",
      headers: {
        authorization: "Bearer klp_printer_token",
        "content-length": "8",
        "content-type": "application/gzip",
      },
      method: "POST",
    });
    assert.equal(invalid.status, 400);

    const listResponse = await dispatch("/api/diagnostic-uploads", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.uploads[0].id, uploadBody.upload.id);
    assert.equal(listBody.uploads[0].printerName, "Bench printer");

    const anonymous = await dispatch(`/api/diagnostic-uploads/${uploadBody.upload.id}`);
    assert.equal(anonymous.status, 401);
    const download = await dispatch(`/api/diagnostic-uploads/${uploadBody.upload.id}`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("cache-control"), "private, no-store");
    assert.equal(gunzipSync(Buffer.from(await download.arrayBuffer())).toString("utf8"), log);

    const row = await db.prepare("SELECT r2_key FROM diagnostic_uploads WHERE id = ?")
      .bind(uploadBody.upload.id)
      .first();
    const bucket = await mf.getR2Bucket("BLOBS");
    assert.match(row.r2_key, /^diagnostics\/[a-f0-9]{64}\/[0-9a-f-]{36}\/klippy\.log\.gz$/);
    assert.equal(row.r2_key.includes("printer_1"), false);
    const storedDiagnostic = await bucket.head(row.r2_key);
    assert.notEqual(storedDiagnostic, null);
    assert.deepEqual(Object.keys(storedDiagnostic.customMetadata ?? {}).sort(), ["expiresAt"]);

    const removed = await dispatch(`/api/diagnostic-uploads/${uploadBody.upload.id}`, {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        origin: WORKER_ORIGIN,
      },
      method: "DELETE",
    });
    assert.equal(removed.status, 200);
    assert.equal(await bucket.head(row.r2_key), null);

    const manifest = JSON.stringify({
      artifacts: [{
        archiveName: "logs/klippy.log",
        kind: "klippy-log",
        originalSizeBytes: Buffer.byteLength(log),
        storedSizeBytes: Buffer.byteLength(log),
        truncated: false,
      }],
      client: { mode: "printer", repositoryId: "repo_1", version: "test" },
      collectionWarnings: [],
      generatedAt: "2026-07-25T10:00:00Z",
      schemaVersion: 2,
    });
    const bundle = zipSync({
      "logs/klippy.log": strToU8(log),
      "manifest.json": strToU8(manifest),
    });
    const bundleResponse = await dispatch("/api/sync/repos/repo_1/diagnostics", {
      body: bundle,
      headers: {
        authorization: "Bearer klp_printer_token",
        "content-length": String(bundle.byteLength),
        "content-type": "application/zip",
        "x-klippee-log-name": "klippee-diagnostics.zip",
        "x-klippee-original-size": String(Buffer.byteLength(log) + Buffer.byteLength(manifest)),
      },
      method: "POST",
    });
    const bundleBody = await bundleResponse.json();
    assert.equal(bundleResponse.status, 201);
    assert.equal(bundleBody.upload.fileName, "klippee-diagnostics.zip");
    const bundleDownload = await dispatch(`/api/diagnostic-uploads/${bundleBody.upload.id}`, {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const expandedBundle = unzipSync(new Uint8Array(await bundleDownload.arrayBuffer()));
    assert.equal(Buffer.from(expandedBundle["logs/klippy.log"]).toString("utf8"), log);

    const invalidZip = await dispatch("/api/sync/repos/repo_1/diagnostics", {
      body: "not zip",
      headers: {
        authorization: "Bearer klp_printer_token",
        "content-length": "7",
        "content-type": "application/zip",
        "x-klippee-log-name": "klippee-diagnostics.zip",
      },
      method: "POST",
    });
    assert.equal(invalidZip.status, 400);
  });

  it("keeps burst diagnostic retention rows and R2 objects coordinated", async () => {
    const bucket = await mf.getR2Bucket("BLOBS");
    const existing = await db.prepare(
      "SELECT id, r2_key FROM diagnostic_uploads WHERE user_id = 'user_1' AND printer_id = 'printer_1'",
    ).all();
    if (existing.results.length) {
      await bucket.delete(existing.results.map((row) => row.r2_key));
      await db.prepare(
        "DELETE FROM diagnostic_uploads WHERE user_id = 'user_1' AND printer_id = 'printer_1'",
      ).run();
    }

    const responses = await Promise.all(Array.from({ length: 18 }, (_, index) => {
      const compressed = gzipSync(`diagnostic retention race ${index}\n`);
      return dispatch("/api/sync/repos/repo_1/diagnostics", {
        body: compressed,
        headers: {
          authorization: "Bearer klp_printer_token",
          "content-length": String(compressed.byteLength),
          "content-type": "application/gzip",
          "x-klippee-log-name": `retention-${index}.log.gz`,
        },
        method: "POST",
      });
    }));
    for (const response of responses) {
      assert.equal([201, 503].includes(response.status), true);
    }

    const retained = await db.prepare(
      `SELECT id, r2_key, size_bytes
       FROM diagnostic_uploads
       WHERE user_id = 'user_1' AND printer_id = 'printer_1'
       ORDER BY created_at DESC, rowid DESC`,
    ).all();
    const diagnosticPrefix = `diagnostics/${await sha256Hex("user_1\0printer_1")}/`;
    const objects = await bucket.list({ prefix: diagnosticPrefix });

    assert.equal(retained.results.length, 5);
    assert.equal(retained.results.every((row) => row.size_bytes > 0), true);
    assert.deepEqual(
      objects.objects.map((object) => object.key).sort(),
      retained.results.map((row) => row.r2_key).sort(),
    );

    const timestamp = new Date().toISOString();
    for (let index = 0; index < 5; index += 1) {
      await db.prepare(
        `INSERT INTO diagnostic_uploads
         (id, user_id, printer_id, repository_id, file_name, content_type, size_bytes,
          original_size_bytes, truncated, r2_key, created_at, expires_at)
         VALUES (?, 'user_1', 'printer_1', 'repo_1', 'pending.log.gz', 'application/gzip',
                 0, 1, 0, ?, ?, '2099-01-01T00:00:00.000Z')`,
      )
        .bind(
          `diagnostic-pending-${index}`,
          `diagnostics/user_1/printer_1/diagnostic-pending-${index}/pending.log.gz`,
          timestamp,
        )
        .run();
    }
    const atCapacity = gzipSync("diagnostic hard-cap check\n");
    const blocked = await dispatch("/api/sync/repos/repo_1/diagnostics", {
      body: atCapacity,
      headers: {
        authorization: "Bearer klp_printer_token",
        "content-length": String(atCapacity.byteLength),
        "content-type": "application/gzip",
      },
      method: "POST",
    });
    const afterBlocked = await bucket.list({ prefix: diagnosticPrefix });
    assert.equal(blocked.status, 503);
    assert.deepEqual(await blocked.json(), { error: "Diagnostic upload retention is busy. Retry shortly." });
    assert.deepEqual(
      afterBlocked.objects.map((object) => object.key).sort(),
      objects.objects.map((object) => object.key).sort(),
    );
    await db.prepare(
      "DELETE FROM diagnostic_uploads WHERE id LIKE 'diagnostic-pending-%' AND size_bytes = 0",
    ).run();
    await bucket.delete(retained.results.map((row) => row.r2_key));
    await db.prepare(
      "DELETE FROM diagnostic_uploads WHERE user_id = 'user_1' AND printer_id = 'printer_1'",
    ).run();
  });

  it("removes diagnostic R2 objects before deleting their printer", async () => {
    const printerId = "printer_diagnostic_delete";
    const createPrinter = await dispatch("/api/printers", {
      body: JSON.stringify({ printer: { id: printerId, name: "Diagnostic delete fixture", repositoryId: "repo_1" } }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(createPrinter.status, 201);

    const uploadId = "diagnostic-delete-upload";
    const objectKey = "diagnostics/user_1/printer_diagnostic_delete/diagnostic-delete-upload.log.gz";
    const bucket = await mf.getR2Bucket("BLOBS");
    const objectBody = gzipSync("fixture diagnostic\n");
    const timestamp = new Date().toISOString();
    await bucket.put(objectKey, objectBody);
    await db.prepare(
      `INSERT INTO diagnostic_uploads
         (id, user_id, printer_id, repository_id, file_name, content_type, size_bytes,
          original_size_bytes, truncated, r2_key, created_at, expires_at)
       VALUES (?, 'user_1', ?, 'repo_1', 'fixture.log.gz', 'application/gzip', ?, 19, 0, ?, ?, ?)`,
    )
      .bind(uploadId, printerId, objectBody.byteLength, objectKey, timestamp, "2099-01-01T00:00:00.000Z")
      .run();
    assert.notEqual(await bucket.head(objectKey), null);

    const deleted = await dispatch(`/api/printers/${printerId}`, {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        origin: WORKER_ORIGIN,
      },
      method: "DELETE",
    });
    const [printerRow, diagnosticRow] = await Promise.all([
      db.prepare("SELECT id FROM printers WHERE id = ?").bind(printerId).first(),
      db.prepare("SELECT id FROM diagnostic_uploads WHERE id = ?").bind(uploadId).first(),
    ]);

    assert.equal(deleted.status, 200);
    assert.equal(printerRow, null);
    assert.equal(diagnosticRow, null);
    assert.equal(await bucket.head(objectKey), null);
  });

  it("does not orphan a diagnostic when its printer is deleted during upload", async () => {
    const printerId = "printer_diagnostic_delete_race";
    const headers = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const createPrinter = await dispatch("/api/printers", {
      body: JSON.stringify({ printer: { id: printerId, name: "Diagnostic delete race", repositoryId: "repo_1" } }),
      headers,
      method: "POST",
    });
    assert.equal(createPrinter.status, 201);
    const createToken = await dispatch("/api/repos/repo_1/sync-tokens", {
      body: JSON.stringify({ name: "Diagnostic delete race", printerId, scopes: ["repo:write"] }),
      headers,
      method: "POST",
    });
    const tokenBody = await createToken.json();
    assert.equal(createToken.status, 201);

    const compressed = gzipSync("diagnostic upload racing printer deletion\n");
    let releaseBody;
    let signalBodyRead;
    const bodyRelease = new Promise((resolve) => {
      releaseBody = resolve;
    });
    const bodyReadStarted = new Promise((resolve) => {
      signalBodyRead = resolve;
    });
    let bodySent = false;
    const body = new ReadableStream({
      async pull(controller) {
        if (bodySent) return;
        bodySent = true;
        signalBodyRead();
        await bodyRelease;
        controller.enqueue(compressed);
        controller.close();
      },
    });
    const uploadPromise = dispatch("/api/sync/repos/repo_1/diagnostics", {
      body,
      duplex: "half",
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-length": String(compressed.byteLength),
        "content-type": "application/gzip",
        "x-klippee-log-name": "race.log.gz",
      },
      method: "POST",
    });
    await bodyReadStarted;

    const deleted = await dispatch(`/api/printers/${printerId}`, {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        origin: WORKER_ORIGIN,
      },
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    releaseBody();

    const upload = await uploadPromise;
    assert.equal([401, 409].includes(upload.status), true);
    const uploadError = await upload.json();
    assert.equal(
      uploadError.error,
      upload.status === 409
        ? "The printer was removed while the diagnostic was uploading"
        : "Invalid sync token",
    );
    const diagnosticRows = await db.prepare(
      "SELECT COUNT(*) AS count FROM diagnostic_uploads WHERE printer_id = ?",
    ).bind(printerId).first();
    const bucket = await mf.getR2Bucket("BLOBS");
    const objects = await bucket.list({ prefix: `diagnostics/user_1/${printerId}/` });
    assert.equal(diagnosticRows.count, 0);
    assert.equal(objects.objects.length, 0);
  });

  it("does not accept sensitive improvement logs when reviewer access is not configured", async () => {
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: "http://localhost",
        LOCAL_AUTH_BYPASS: "1",
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-log-review-disabled-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-log-review-disabled-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const tempDb = await tempMf.getD1Database("DB");
      await applyMigrations(tempDb);
      const log = "redacted fixture log\n";
      const response = await tempMf.dispatchFetch("http://localhost/api/log-improvement-submissions", {
        body: log,
        headers: {
          "content-length": String(Buffer.byteLength(log)),
          "content-type": "text/plain",
          origin: "http://localhost",
          "x-klippee-consent-version": "2026-07-24",
          "x-klippee-redaction-confirmed": "1",
        },
        method: "POST",
      });
      const rowCount = await tempDb.prepare(
        "SELECT COUNT(*) AS count FROM log_improvement_submissions",
      ).first();

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Log improvement review access is not configured" });
      assert.equal(rowCount.count, 0);
    } finally {
      await tempMf.dispose();
    }
  });

  it("rejects declared and disguised gzip improvement logs that expand beyond the original-size limit", async () => {
    const expanded = Buffer.alloc(64 * 1024 * 1024 + 1, 0x41);
    const compressed = gzipSync(expanded);
    const before = await db.prepare(
      "SELECT COUNT(*) AS count FROM log_improvement_submissions",
    ).first();
    for (const [contentType, fileName] of [
      ["application/gzip", "expansion-bomb.log.gz"],
      ["application/octet-stream", "disguised-expansion-bomb.log"],
    ]) {
      const response = await dispatch("/api/log-improvement-submissions", {
        body: compressed,
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          "content-length": String(compressed.byteLength),
          "content-type": contentType,
          origin: WORKER_ORIGIN,
          "x-klippee-consent-version": "2026-07-24",
          "x-klippee-log-name": fileName,
          "x-klippee-original-size": "1",
          "x-klippee-redaction-confirmed": "1",
        },
        method: "POST",
      });

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "Expanded log submission exceeds the 64 MiB limit" });
    }
    const after = await db.prepare(
      "SELECT COUNT(*) AS count FROM log_improvement_submissions",
    ).first();

    assert.equal(after.count, before.count);
  });

  it("stores consented improvement logs as gzip and protects developer retrieval", async () => {
    const log = "Stats 1.0: heater_bed: target=60 temp=55\nTransition to shutdown state: ADC out of range\n";
    const missingConsent = await dispatch("/api/log-improvement-submissions", {
      body: log,
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-length": String(Buffer.byteLength(log)),
        "content-type": "text/plain",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(missingConsent.status, 400);

    const anonymous = await dispatch("/api/log-improvement-submissions", {
      body: log,
      headers: {
        "content-length": String(Buffer.byteLength(log)),
        "content-type": "text/plain",
        origin: WORKER_ORIGIN,
        "x-klippee-consent-version": "2026-07-24",
        "x-klippee-redaction-confirmed": "1",
      },
      method: "POST",
    });
    assert.equal(anonymous.status, 401);

    const upload = await dispatch("/api/log-improvement-submissions", {
      body: log,
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-length": String(Buffer.byteLength(log)),
        "content-type": "text/plain",
        origin: WORKER_ORIGIN,
        "x-klippee-consent-version": "2026-07-24",
        "x-klippee-log-name": encodeURIComponent("klippy latest.log"),
        "x-klippee-original-size": String(Buffer.byteLength(log)),
        "x-klippee-redaction-confirmed": "1",
      },
      method: "POST",
    });
    const uploadBody = await upload.json();
    assert.equal(upload.status, 201);
    assert.equal(uploadBody.submission.originalFileName, "klippy_latest.log");
    assert.equal(uploadBody.submission.fileName, "klippy_latest.log.gz");
    assert.equal(uploadBody.submission.originalSizeBytes, Buffer.byteLength(log));
    assert.ok(uploadBody.submission.sizeBytes > 0);
    assert.ok(
      Math.abs(
        new Date(uploadBody.submission.expiresAt).getTime()
        - new Date(uploadBody.submission.createdAt).getTime()
        - 90 * 24 * 60 * 60 * 1000,
      ) < 1_000,
    );

    const row = await db.prepare(
      "SELECT r2_key, consent_version, redaction_confirmed FROM log_improvement_submissions WHERE id = ?",
    )
      .bind(uploadBody.submission.id)
      .first();
    const bucket = await mf.getR2Bucket("BLOBS");
    const stored = await bucket.get(row.r2_key);
    assert.notEqual(stored, null);
    assert.equal(row.consent_version, "2026-07-24");
    assert.equal(row.redaction_confirmed, 1);
    assert.equal(gunzipSync(Buffer.from(await stored.arrayBuffer())).toString("utf8"), log);

    const unauthenticatedReview = await dispatch("/api/internal/log-improvement-submissions");
    assert.equal(unauthenticatedReview.status, 401);

    const list = await dispatch("/api/internal/log-improvement-submissions", {
      headers: { authorization: `Bearer ${REVIEW_TOKEN}` },
    });
    const listBody = await list.json();
    assert.equal(list.status, 200);
    const listed = listBody.submissions.find((submission) => submission.id === uploadBody.submission.id);
    assert.equal(listed.originalFileName, "klippy_latest.log");
    assert.equal(listed.sha256, uploadBody.submission.sha256);

    const download = await dispatch(listed.downloadPath, {
      headers: { authorization: `Bearer ${REVIEW_TOKEN}` },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/gzip");
    assert.equal(download.headers.get("x-klippee-sha256"), uploadBody.submission.sha256);
    assert.equal(gunzipSync(Buffer.from(await download.arrayBuffer())).toString("utf8"), log);

    const otherUserDelete = await dispatch(`/api/log-improvement-submissions/${uploadBody.submission.id}`, {
      headers: {
        cookie: `__Host-klippee_session=${SECOND_SESSION_TOKEN}`,
        origin: WORKER_ORIGIN,
      },
      method: "DELETE",
    });
    assert.equal(otherUserDelete.status, 404);

    const withdraw = await dispatch(`/api/log-improvement-submissions/${uploadBody.submission.id}`, {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        origin: WORKER_ORIGIN,
      },
      method: "DELETE",
    });
    assert.equal(withdraw.status, 200);
    assert.equal(await bucket.head(row.r2_key), null);
  });

  it("keeps burst improvement-log retention rows and R2 objects coordinated", async () => {
    const responses = await Promise.all(Array.from({ length: 48 }, (_, index) => {
      const compressed = gzipSync(`redacted improvement retention race ${index}\n`);
      return dispatch("/api/log-improvement-submissions", {
        body: compressed,
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          "content-length": String(compressed.byteLength),
          "content-type": "application/gzip",
          origin: WORKER_ORIGIN,
          "x-klippee-consent-version": "2026-07-24",
          "x-klippee-log-name": `retention-${index}.log.gz`,
          "x-klippee-redaction-confirmed": "1",
        },
        method: "POST",
      });
    }));
    for (const response of responses) {
      assert.equal([201, 503].includes(response.status), true);
    }

    const retained = await db.prepare(
      `SELECT id, r2_key, size_bytes
       FROM log_improvement_submissions
       WHERE user_id = 'user_1'
       ORDER BY created_at DESC, rowid DESC`,
    ).all();
    const bucket = await mf.getR2Bucket("BLOBS");
    const objects = await bucket.list({ prefix: "diagnostic-improvements/" });

    assert.equal(retained.results.length, 20);
    assert.equal(retained.results.every((row) => row.size_bytes > 0), true);
    assert.deepEqual(
      objects.objects.map((object) => object.key).sort(),
      retained.results.map((row) => row.r2_key).sort(),
    );

    const timestamp = new Date().toISOString();
    for (let index = 0; index < 20; index += 1) {
      await db.prepare(
        `INSERT INTO log_improvement_submissions
         (id, user_id, original_file_name, file_name, size_bytes, original_size_bytes,
          sha256, r2_key, consent_version, consented_at, redaction_confirmed, created_at, expires_at)
         VALUES (?, 'user_1', 'pending.log', 'pending.log.gz', 0, 1, ?, ?,
                 '2026-07-24', ?, 1, ?, '2099-01-01T00:00:00.000Z')`,
      )
        .bind(
          `improvement-pending-${index}`,
          `${index}`.padStart(64, "0"),
          `diagnostic-improvements/improvement-pending-${index}/pending.log.gz`,
          timestamp,
          timestamp,
        )
        .run();
    }
    const atCapacity = gzipSync("improvement hard-cap check\n");
    const blocked = await dispatch("/api/log-improvement-submissions", {
      body: atCapacity,
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-length": String(atCapacity.byteLength),
        "content-type": "application/gzip",
        origin: WORKER_ORIGIN,
        "x-klippee-consent-version": "2026-07-24",
        "x-klippee-redaction-confirmed": "1",
      },
      method: "POST",
    });
    const afterBlocked = await bucket.list({ prefix: "diagnostic-improvements/" });
    assert.equal(blocked.status, 503);
    assert.deepEqual(
      await blocked.json(),
      { error: "Log improvement submission retention is busy. Retry shortly." },
    );
    assert.deepEqual(
      afterBlocked.objects.map((object) => object.key).sort(),
      objects.objects.map((object) => object.key).sort(),
    );
    await db.prepare(
      "DELETE FROM log_improvement_submissions WHERE id LIKE 'improvement-pending-%' AND size_bytes = 0",
    ).run();
    await bucket.delete(retained.results.map((row) => row.r2_key));
    await db.prepare("DELETE FROM log_improvement_submissions WHERE user_id = 'user_1'").run();
  });
});
