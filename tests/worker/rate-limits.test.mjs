import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { Miniflare } from "./miniflare.mjs";
import {
  REVIEW_TOKEN,
  SESSION_SECRET,
  WORKER_ORIGIN,
  applyMigrations,
  assertUploadRateLimit,
  enterStableRateLimitWindow,
  seedUploadRateLimitFixtures,
  sha256Hex,
  waitForNextRateLimitWindow,
} from "./helpers.mjs";

describe("worker API smoke: rate-limits", () => {
  it("rate-limits authenticated diagnostic storage by stable printer and user principals", async () => {
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: WORKER_ORIGIN,
        LOG_IMPROVEMENT_REVIEW_TOKEN: REVIEW_TOKEN,
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-authenticated-upload-ratelimit-test" },
      modules: true,
      ratelimits: {
        DIAGNOSTIC_UPLOAD_RATE_LIMITER: {
          namespace_id: "test-authenticated-diagnostic-uploads",
          simple: { limit: 2, period: 10 },
        },
        LOG_IMPROVEMENT_RATE_LIMITER: {
          namespace_id: "test-authenticated-log-improvements",
          simple: { limit: 2, period: 10 },
        },
      },
      r2Buckets: { BLOBS: "klippee-authenticated-upload-ratelimit-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const tempDb = await tempMf.getD1Database("DB");
      const bucket = await tempMf.getR2Bucket("BLOBS");
      await applyMigrations(tempDb);
      const fixtures = await seedUploadRateLimitFixtures(tempDb);
      // Production uses 60-second windows. The native Miniflare binding uses
      // an accelerated 10-second window here so recovery remains deterministic
      // without making the Worker suite sleep for a minute.
      await enterStableRateLimitWindow(10);
      const diagnostic = gzipSync("rate-limited diagnostic fixture\n");
      const uploadDiagnostic = (token, contentType = "application/gzip") => tempMf.dispatchFetch(
        new URL("/api/sync/repos/rate_repo/diagnostics", WORKER_ORIGIN),
        {
          body: diagnostic,
          headers: {
            authorization: `Bearer ${token}`,
            "content-length": String(diagnostic.byteLength),
            "content-type": contentType,
          },
          method: "POST",
        },
      );

      const invalidDiagnostic = await uploadDiagnostic(fixtures.printerTokenA, "application/json");
      assert.equal(invalidDiagnostic.status, 415);

      const firstDiagnostic = await uploadDiagnostic(fixtures.printerTokenA);
      const secondDiagnostic = await uploadDiagnostic(fixtures.printerTokenA);
      assert.equal(firstDiagnostic.status, 201);
      assert.equal(secondDiagnostic.status, 201);

      const diagnosticPrefix = `diagnostics/${await sha256Hex("rate_user_a\0rate_printer_a")}/`;
      const diagnosticRowsBefore = await tempDb.prepare(
        "SELECT COUNT(*) AS count FROM diagnostic_uploads WHERE printer_id = 'rate_printer_a'",
      ).first();
      const diagnosticObjectsBefore = await bucket.list({ prefix: diagnosticPrefix });
      const rotatedToken = await uploadDiagnostic(fixtures.printerTokenB);
      await assertUploadRateLimit(
        rotatedToken,
        "printer-diagnostic-uploads",
        "Too many diagnostic uploads for this printer. Retry after 60 seconds.",
      );
      const diagnosticRowsAfter = await tempDb.prepare(
        "SELECT COUNT(*) AS count FROM diagnostic_uploads WHERE printer_id = 'rate_printer_a'",
      ).first();
      const diagnosticObjectsAfter = await bucket.list({ prefix: diagnosticPrefix });

      assert.equal(diagnosticRowsBefore.count, 2);
      assert.equal(diagnosticRowsAfter.count, diagnosticRowsBefore.count);
      assert.deepEqual(
        diagnosticObjectsAfter.objects.map((object) => object.key).sort(),
        diagnosticObjectsBefore.objects.map((object) => object.key).sort(),
      );

      const independentPrinter = await uploadDiagnostic(fixtures.printerTokenC);
      assert.equal(independentPrinter.status, 201);

      const improvement = Buffer.from("redacted rate-limited improvement fixture\n");
      const submitImprovement = (session, includeConsent = true) => tempMf.dispatchFetch(
        new URL("/api/log-improvement-submissions", WORKER_ORIGIN),
        {
          body: improvement,
          headers: {
            cookie: `__Host-klippee_session=${session}`,
            "content-length": String(improvement.byteLength),
            "content-type": "text/plain",
            origin: WORKER_ORIGIN,
            ...(includeConsent
              ? {
                  "x-klippee-consent-version": "2026-07-24",
                  "x-klippee-redaction-confirmed": "1",
                }
              : {}),
          },
          method: "POST",
        },
      );

      const missingConsent = await submitImprovement(fixtures.sessionA, false);
      assert.equal(missingConsent.status, 400);

      const firstImprovement = await submitImprovement(fixtures.sessionA);
      const secondImprovement = await submitImprovement(fixtures.sessionA);
      assert.equal(firstImprovement.status, 201);
      assert.equal(secondImprovement.status, 201);

      const improvementRowsBefore = await tempDb.prepare(
        "SELECT COUNT(*) AS count FROM log_improvement_submissions WHERE user_id = 'rate_user_a'",
      ).first();
      const improvementObjectsBefore = await bucket.list({ prefix: "diagnostic-improvements/" });
      const rotatedSession = await submitImprovement(fixtures.sessionA2);
      await assertUploadRateLimit(
        rotatedSession,
        "log-improvement-submissions",
        "Too many log improvement submissions for this account. Retry after 60 seconds.",
      );
      const improvementRowsAfter = await tempDb.prepare(
        "SELECT COUNT(*) AS count FROM log_improvement_submissions WHERE user_id = 'rate_user_a'",
      ).first();
      const improvementObjectsAfter = await bucket.list({ prefix: "diagnostic-improvements/" });

      assert.equal(improvementRowsBefore.count, 2);
      assert.equal(improvementRowsAfter.count, improvementRowsBefore.count);
      assert.deepEqual(
        improvementObjectsAfter.objects.map((object) => object.key).sort(),
        improvementObjectsBefore.objects.map((object) => object.key).sort(),
      );

      const independentUser = await submitImprovement(fixtures.sessionB);
      assert.equal(independentUser.status, 201);

      await waitForNextRateLimitWindow(10);
      const recoveredDiagnostic = await uploadDiagnostic(fixtures.printerTokenA);
      const recoveredImprovement = await submitImprovement(fixtures.sessionA2);
      assert.equal(recoveredDiagnostic.status, 201);
      assert.equal(recoveredImprovement.status, 201);
    } finally {
      await tempMf.dispose();
    }
  });
});
