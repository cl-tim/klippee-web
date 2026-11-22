import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Miniflare } from "./miniflare.mjs";
import {
  SESSION_SECRET,
  SESSION_TOKEN,
  STORAGE_LIMITS,
  STORAGE_MAINTENANCE_TOKEN,
  STORAGE_RESOURCES,
  WORKER_ORIGIN,
  applyMigration,
  applyMigrations,
  armReclaimHook,
  assertStorageQuota,
  bootSharedWorker,
  clearReclaimHook,
  db,
  dispatch,
  disposeSharedWorker,
  hashToken,
  mf,
  reclaimHookState,
  sha256Hex,
} from "./helpers.mjs";

describe("worker API smoke: storage-maintenance", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("backfills canonical blob budgets from retained v2 manifests", async () => {
    const backfillMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      d1Databases: { DB: "klippee-blob-backfill-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-blob-backfill-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const backfillDb = await backfillMf.getD1Database("DB");
      await applyMigrations(backfillDb, "0020_public_package_approval.sql");
      const timestamp = "2026-08-04T03:00:00.000Z";
      const hashes = {
        a: "a".repeat(64),
        b: "b".repeat(64),
        c: "c".repeat(64),
        d: "d".repeat(64),
        ignored: "e".repeat(64),
      };
      const manifest = (entries, version = 2) => JSON.stringify({
        entries,
        storage: "r2-blobs",
        version,
      });
      const storedPackage = (entries) => JSON.stringify({
        bodyStorage: "r2-blobs",
        bodyVersion: 2,
        filesManifest: manifest(entries),
      });

      await backfillDb.batch([
        backfillDb.prepare(
          `INSERT INTO users (id, display_name, avatar_url, created_at, updated_at)
           VALUES ('backfill-user-1', 'Backfill one', NULL, ?, ?),
                  ('backfill-user-2', 'Backfill two', NULL, ?, ?)`,
        ).bind(timestamp, timestamp, timestamp, timestamp),
        backfillDb.prepare(
          `INSERT INTO repositories
             (id, user_id, name, title, latest_version_id, created_at, updated_at, pending_files_json)
           VALUES ('backfill-repo-1', 'backfill-user-1', 'backfill-one', 'Backfill one', NULL, ?, ?, ?),
                  ('backfill-repo-2', 'backfill-user-2', 'backfill-two', 'Backfill two', NULL, ?, ?, 'not-json')`,
        ).bind(
          timestamp,
          timestamp,
          manifest(["plain", 123, { byteLength: 10, sha256: hashes.a }]),
          timestamp,
          timestamp,
        ),
        backfillDb.prepare(
          `INSERT INTO repository_versions
             (id, repository_id, version_number, previous_version_id, message, source, files_json, created_at)
           VALUES ('backfill-version-1', 'backfill-repo-1', 1, NULL, 'v2', 'test', ?, ?),
                  ('backfill-version-2', 'backfill-repo-1', 2, 'backfill-version-1', 'wrong version', 'test', ?, ?),
                  ('backfill-version-3', 'backfill-repo-2', 1, NULL, 'malformed', 'test', 'not-json', ?)`,
        ).bind(
          manifest([
            { byteLength: 10, sha256: hashes.a },
            { byteLength: 70_000, sha256: hashes.b },
          ]),
          timestamp,
          manifest([{ byteLength: 5, sha256: hashes.ignored }], 3),
          timestamp,
          timestamp,
        ),
        backfillDb.prepare(
          `INSERT INTO private_packages
             (id, user_id, package_id, name, title, package_json, created_at, updated_at)
           VALUES ('backfill-private-1', 'backfill-user-1', 'private-1', 'private-1', 'Private one', ?, ?, ?),
                  ('backfill-private-bad', 'backfill-user-1', 'private-bad', 'private-bad', 'Private bad', 'not-json', ?, ?)`,
        ).bind(
          storedPackage([{ byteLength: 20, sha256: hashes.c }]),
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        ),
        backfillDb.prepare(
          `INSERT INTO public_packages
             (id, user_id, source_package_id, slug, name, title, package_json, created_at, updated_at, published_at)
           VALUES ('backfill-public-1', 'backfill-user-2', 'public-1', 'backfill-public-1',
                   'public-1', 'Public one', ?, ?, ?, ?)`,
        ).bind(
          storedPackage([
            { byteLength: 10, sha256: hashes.a },
            { byteLength: 0, sha256: hashes.d },
          ]),
          timestamp,
          timestamp,
          timestamp,
        ),
      ]);
      const legacyKey = "repositories/backfill-repo-2/versions/sha256/legacy.json";
      await backfillDb.prepare(
        `INSERT INTO repository_versions
           (id, repository_id, version_number, previous_version_id, message, source, files_json, created_at)
         VALUES ('backfill-version-v1', 'backfill-repo-2', 2, 'backfill-version-3',
                 'legacy v1', 'test', ?, ?)`,
      ).bind(JSON.stringify({
        byteLength: 20,
        fileCount: 1,
        key: legacyKey,
        sha256: hashes.ignored,
        storage: "r2",
        version: 1,
      }), timestamp).run();

      await applyMigration(backfillDb, "0021_canonical_blob_budgets.sql");
      const canonical = await backfillDb.prepare(
        `SELECT sha256, size_bytes, charge_bytes, stored_at FROM canonical_blobs ORDER BY sha256`,
      ).all();
      assert.deepEqual(canonical.results, [
        { charge_bytes: 65_536, sha256: hashes.a, size_bytes: 10, stored_at: "2026-08-04T04:00:00.000Z" },
        { charge_bytes: 70_000, sha256: hashes.b, size_bytes: 70_000, stored_at: "2026-08-04T04:00:00.000Z" },
        { charge_bytes: 65_536, sha256: hashes.c, size_bytes: 20, stored_at: "2026-08-04T04:00:00.000Z" },
        { charge_bytes: 65_536, sha256: hashes.d, size_bytes: 0, stored_at: "2026-08-04T04:00:00.000Z" },
      ]);
      const userTotals = await backfillDb.prepare(
        `SELECT user_id, charge_bytes FROM user_blob_budget_totals ORDER BY user_id`,
      ).all();
      assert.deepEqual(userTotals.results, [
        { charge_bytes: 201_072, user_id: "backfill-user-1" },
        { charge_bytes: 131_072, user_id: "backfill-user-2" },
      ]);
      const serviceTotal = await backfillDb.prepare(
        `SELECT charge_bytes FROM canonical_blob_budget_total WHERE id = 1`,
      ).first();
      assert.equal(serviceTotal.charge_bytes, 266_608);

      await applyMigration(backfillDb, "0021_canonical_blob_budgets.sql");
      const afterRerun = await backfillDb.prepare(
        `SELECT (SELECT COUNT(*) FROM canonical_blobs) AS blob_count,
                (SELECT COUNT(*) FROM user_blob_claims) AS claim_count,
                (SELECT charge_bytes FROM canonical_blob_budget_total WHERE id = 1) AS service_total`,
      ).first();
      assert.deepEqual(afterRerun, { blob_count: 4, claim_count: 5, service_total: 266_608 });

      await applyMigration(backfillDb, "0022_canonical_blob_reclamation.sql");
      const referenceCounts = await backfillDb.prepare(
        `SELECT source_type, COUNT(*) AS count
         FROM canonical_blob_references
         GROUP BY source_type
         ORDER BY source_type`,
      ).all();
      assert.deepEqual(referenceCounts.results, [
        { count: 1, source_type: "private_package" },
        { count: 2, source_type: "public_package" },
        { count: 1, source_type: "repository_pending" },
        { count: 2, source_type: "repository_version" },
      ]);
      const referenceDrift = await backfillDb.prepare(
        `SELECT COUNT(*) AS count
         FROM canonical_blob_manifest_references AS manifest
         LEFT JOIN canonical_blob_references AS normalized
           ON normalized.source_type = manifest.source_type
          AND normalized.source_id = manifest.source_id
          AND normalized.sha256 = manifest.sha256
         WHERE normalized.sha256 IS NULL`,
      ).first();
      assert.equal(referenceDrift.count, 0);
      assert.deepEqual(
        await backfillDb.prepare(
          `SELECT r2_key, sha256, size_bytes
           FROM legacy_repository_manifest_references`,
        ).first(),
        { r2_key: legacyKey, sha256: hashes.ignored, size_bytes: 20 },
      );
      assert.deepEqual((await backfillDb.prepare("PRAGMA foreign_key_list(user_blob_claims)").all()).results, []);

      await backfillDb.prepare(
        `INSERT INTO canonical_blob_gc_candidates
           (r2_key, sha256, first_seen_at, last_checked_at, reclaim_after)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        `blobs/sha256/${hashes.a}`,
        hashes.a,
        timestamp,
        timestamp,
        timestamp,
      ).run();
      assert.equal(
        await backfillDb.prepare("SELECT r2_key FROM canonical_blob_gc_candidates WHERE sha256 = ?")
          .bind(hashes.a)
          .first(),
        null,
      );
    } finally {
      await backfillMf.dispose();
    }
  });

  it("enforces persistent object limits at the atomic write boundary", async () => {
    const quotaOrigin = "http://localhost:5173";
    const quotaMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: quotaOrigin,
        LOCAL_AUTH_BYPASS: "1",
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-storage-quota-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-storage-quota-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const quotaDb = await quotaMf.getD1Database("DB");
      const quotaBucket = await quotaMf.getR2Bucket("BLOBS");
      const quotaDispatch = (path, init) => quotaMf.dispatchFetch(new URL(path, quotaOrigin), init);
      const mutationHeaders = {
        "content-type": "application/json",
        origin: quotaOrigin,
      };
      const raceAtLimit = async (requests, resource, limit) => {
        const responses = await Promise.all(requests);
        const results = await Promise.all(responses.map(async (response) => ({
          body: await response.json(),
          status: response.status,
        })));
        assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
        assertStorageQuota(results.find((result) => result.status === 409).body, resource, limit);
        return results.find((result) => result.status === 201).body;
      };
      const packageBody = (id, content) => ({
        package: {
          description: `Quota fixture ${id}`,
          files: [{ content, path: "printer.cfg", public: false, role: "printer" }],
          hardware: ["cartesian"],
          id,
          name: id,
          printer: "Quota fixture",
          tags: ["quota"],
          title: id,
          variables: [],
          version: "1",
          warnings: [],
        },
      });
      const assetBody = (id, title) => ({
        asset: {
          content: JSON.stringify({ name: title, type: "machine" }),
          description: "Quota fixture",
          id,
          kind: "machine",
          tags: ["quota"],
          title,
        },
      });

      await applyMigrations(quotaDb);
      const auth = await quotaDispatch("/api/auth/me");
      assert.equal(auth.status, 200);
      const timestamp = new Date().toISOString();

      await quotaDb.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 31
         )
         INSERT INTO repositories (id, user_id, name, title, latest_version_id, created_at, updated_at)
         SELECT 'quota-repository-' || value, 'local-dev-user', 'quota-repository-' || value,
                'Quota repository ' || value, NULL, ?, ?
         FROM sequence`,
      ).bind(timestamp, timestamp).run();
      await quotaDb.prepare(
        `INSERT INTO repository_versions
           (id, repository_id, version_number, previous_version_id, message, source, files_json, created_at)
         VALUES ('quota-fork-source-version', 'quota-repository-1', 1, NULL,
                 'Fork source', 'test', ?, ?)`,
      ).bind(JSON.stringify([{
        content: "[printer]\nkinematics: cartesian\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      }]), timestamp).run();
      await quotaDb.prepare(
        "UPDATE repositories SET latest_version_id = 'quota-fork-source-version' WHERE id = 'quota-repository-1'",
      ).run();

      const createdRepository = await raceAtLimit([
        quotaDispatch("/api/repos", {
          body: JSON.stringify({ empty: true, name: "quota-race-a", title: "Quota race A" }),
          headers: mutationHeaders,
          method: "POST",
        }),
        quotaDispatch("/api/repos", {
          body: JSON.stringify({ empty: true, name: "quota-race-b", title: "Quota race B" }),
          headers: mutationHeaders,
          method: "POST",
        }),
      ], STORAGE_RESOURCES.repositories, STORAGE_LIMITS.repositories);
      const repositoryCount = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM repositories WHERE user_id = 'local-dev-user'",
      ).first();
      assert.equal(repositoryCount.count, STORAGE_LIMITS.repositories);
      const rejectedFork = await quotaDispatch("/api/repos/quota-repository-1/forks", {
        body: JSON.stringify({ name: "quota-rejected-fork", versionNumber: 1 }),
        headers: mutationHeaders,
        method: "POST",
      });
      assert.equal(rejectedFork.status, 409);
      assertStorageQuota(
        await rejectedFork.json(),
        STORAGE_RESOURCES.repositories,
        STORAGE_LIMITS.repositories,
      );

      const repositoryId = createdRepository.repository.id;
      await quotaDb.prepare(
        `INSERT INTO user_blob_claims
           (user_id, sha256, size_bytes, charge_bytes, created_at)
         VALUES ('local-dev-user', ?, 1, ?, ?)`,
      ).bind("f".repeat(64), STORAGE_LIMITS.canonicalBlobBytesPerUser, timestamp).run();
      const userBudgetRejectedContent = "[printer]\nkinematics: corexy\n# unique budget rejection\n";
      const userBudgetRejectedHash = await sha256Hex(userBudgetRejectedContent);
      const candidateFirstSeenAt = "2000-01-01T00:00:00.000Z";
      await quotaDb.prepare(
        `INSERT INTO canonical_blob_gc_candidates
           (r2_key, sha256, first_seen_at, last_checked_at, reclaim_after)
         VALUES (?, ?, ?, ?, '2999-01-01T00:00:00.000Z')`,
      ).bind(
        `blobs/sha256/${userBudgetRejectedHash}`,
        userBudgetRejectedHash,
        candidateFirstSeenAt,
        candidateFirstSeenAt,
      ).run();
      const blobsBeforeBudgetRejection = await quotaBucket.list({ prefix: "blobs/sha256/" });
      const rejectedByBlobBudget = await quotaDispatch(`/api/repos/${repositoryId}/versions`, {
        body: JSON.stringify({
          files: [{
            content: userBudgetRejectedContent,
            path: "printer.cfg",
            public: false,
            role: "printer",
          }],
        }),
        headers: mutationHeaders,
        method: "POST",
      });
      assert.equal(rejectedByBlobBudget.status, 409);
      assert.deepEqual(await rejectedByBlobBudget.json(), {
        code: "canonical_blob_budget_exceeded",
        error: "Cloud file-body budget reached. Reuse existing file content or contact the operator to reclaim unreferenced blobs.",
        limitBytes: STORAGE_LIMITS.canonicalBlobBytesPerUser,
        resource: "canonical-file-bodies",
      });
      const blobsAfterBudgetRejection = await quotaBucket.list({ prefix: "blobs/sha256/" });
      assert.deepEqual(
        blobsAfterBudgetRejection.objects.map((object) => object.key).sort(),
        blobsBeforeBudgetRejection.objects.map((object) => object.key).sort(),
      );
      assert.equal(
        (await quotaDb.prepare(
          "SELECT first_seen_at FROM canonical_blob_gc_candidates WHERE sha256 = ?",
        ).bind(userBudgetRejectedHash).first()).first_seen_at,
        candidateFirstSeenAt,
      );
      await quotaDb.prepare(
        "DELETE FROM user_blob_claims WHERE user_id = 'local-dev-user' AND sha256 = ?",
      ).bind("f".repeat(64)).run();

      await quotaDb.prepare(
        `INSERT INTO canonical_blobs
           (sha256, size_bytes, charge_bytes, created_at, stored_at)
         VALUES (?, 1, ?, ?, ?)`,
      ).bind(
        "e".repeat(64),
        STORAGE_LIMITS.canonicalBlobBytesTotal,
        timestamp,
        timestamp,
      ).run();
      const claimsBeforeServiceRejection = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM user_blob_claims WHERE user_id = 'local-dev-user'",
      ).first();
      const blobsBeforeServiceRejection = await quotaBucket.list({ prefix: "blobs/sha256/" });
      const rejectedByServiceBudget = await quotaDispatch(`/api/repos/${repositoryId}/versions`, {
        body: JSON.stringify({
          files: [{
            content: "[printer]\nkinematics: corexy\n# unique service rejection\n",
            path: "printer.cfg",
            public: false,
            role: "printer",
          }],
        }),
        headers: mutationHeaders,
        method: "POST",
      });
      assert.equal(rejectedByServiceBudget.status, 503);
      assert.deepEqual(await rejectedByServiceBudget.json(), {
        code: "canonical_blob_capacity_reached",
        error: "Cloud file storage is temporarily at capacity. Try again later.",
        resource: "canonical-file-bodies",
      });
      const claimsAfterServiceRejection = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM user_blob_claims WHERE user_id = 'local-dev-user'",
      ).first();
      assert.equal(claimsAfterServiceRejection.count, claimsBeforeServiceRejection.count);
      const blobsAfterServiceRejection = await quotaBucket.list({ prefix: "blobs/sha256/" });
      assert.deepEqual(
        blobsAfterServiceRejection.objects.map((object) => object.key).sort(),
        blobsBeforeServiceRejection.objects.map((object) => object.key).sort(),
      );
      await quotaDb.prepare("DELETE FROM canonical_blobs WHERE sha256 = ?")
        .bind("e".repeat(64))
        .run();

      // Existing content must remain reusable and repairable if a migration
      // backfill or a later policy reduction leaves both ledgers above their
      // current caps. Neither request delta adds charged bytes in this case.
      const repairContent = "[printer]\nkinematics: cartesian\n# repair pending canonical body\n";
      const repairHash = await sha256Hex(repairContent);
      const repairSize = new TextEncoder().encode(repairContent).byteLength;
      await quotaDb.batch([
        quotaDb.prepare(
          `INSERT INTO canonical_blobs
             (sha256, size_bytes, charge_bytes, created_at, stored_at)
           VALUES (?, ?, ?, ?, NULL)`,
        ).bind(
          repairHash,
          repairSize,
          STORAGE_LIMITS.canonicalBlobBytesTotal + 65_536,
          timestamp,
        ),
        quotaDb.prepare(
          `INSERT INTO user_blob_claims
             (user_id, sha256, size_bytes, charge_bytes, created_at)
           VALUES ('local-dev-user', ?, ?, ?, ?)`,
        ).bind(
          repairHash,
          repairSize,
          STORAGE_LIMITS.canonicalBlobBytesPerUser + 65_536,
          timestamp,
        ),
      ]);
      const repaired = await quotaDispatch(`/api/repos/${repositoryId}/versions`, {
        body: JSON.stringify({
          files: [{
            content: repairContent,
            path: "printer.cfg",
            public: false,
            role: "printer",
          }],
        }),
        headers: mutationHeaders,
        method: "POST",
      });
      const repairedBody = await repaired.json();
      assert.equal(repaired.status, 201);
      assert.notEqual(await quotaBucket.head(`blobs/sha256/${repairHash}`), null);
      const repairTotals = await quotaDb.prepare(
        `SELECT
           (SELECT charge_bytes FROM canonical_blob_budget_total WHERE id = 1) AS service_total,
           (SELECT charge_bytes FROM user_blob_budget_totals WHERE user_id = 'local-dev-user') AS user_total`,
      ).first();
      assert.deepEqual(repairTotals, {
        service_total: STORAGE_LIMITS.canonicalBlobBytesTotal + 65_536,
        user_total: STORAGE_LIMITS.canonicalBlobBytesPerUser + 65_536,
      });
      await quotaDb.batch([
        quotaDb.prepare(
          "UPDATE repositories SET latest_version_id = NULL WHERE id = ? AND latest_version_id = ?",
        ).bind(repositoryId, repairedBody.version.id),
        quotaDb.prepare("DELETE FROM repository_versions WHERE id = ? AND repository_id = ?")
          .bind(repairedBody.version.id, repositoryId),
        quotaDb.prepare("DELETE FROM user_blob_claims WHERE user_id = 'local-dev-user' AND sha256 = ?")
          .bind(repairHash),
        quotaDb.prepare("DELETE FROM canonical_blobs WHERE sha256 = ?").bind(repairHash),
      ]);
      await quotaBucket.delete(`blobs/sha256/${repairHash}`);

      await quotaDb.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 255
         )
         INSERT INTO repository_versions
           (id, repository_id, version_number, previous_version_id, message, source, files_json, created_at)
         SELECT 'quota-version-' || value, ?, value,
                CASE WHEN value = 1 THEN NULL ELSE 'quota-version-' || (value - 1) END,
                'Quota version ' || value, 'test', '[]', ?
         FROM sequence`,
      ).bind(repositoryId, timestamp).run();
      await quotaDb.prepare(
        "UPDATE repositories SET latest_version_id = 'quota-version-255' WHERE id = ?",
      ).bind(repositoryId).run();
      const sharedVersionFiles = [{
        content: "[printer]\nkinematics: cartesian\n# quota race\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      }];
      await raceAtLimit([
        quotaDispatch(`/api/repos/${repositoryId}/versions`, {
          body: JSON.stringify({ files: sharedVersionFiles, message: "Quota version race A" }),
          headers: mutationHeaders,
          method: "POST",
        }),
        quotaDispatch(`/api/repos/${repositoryId}/versions`, {
          body: JSON.stringify({ files: sharedVersionFiles, message: "Quota version race B" }),
          headers: mutationHeaders,
          method: "POST",
        }),
      ], STORAGE_RESOURCES.repositoryVersions, STORAGE_LIMITS.repositoryVersions);
      const versionCount = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM repository_versions WHERE repository_id = ?",
      ).bind(repositoryId).first();
      const claimedBlobs = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM user_blob_claims WHERE user_id = 'local-dev-user'",
      ).first();
      assert.equal(versionCount.count, STORAGE_LIMITS.repositoryVersions);
      assert.equal(claimedBlobs.count, 1);

      const blobsBeforeRejectedVersion = await quotaBucket.list({ prefix: "blobs/sha256/" });
      const rejectedVersion = await quotaDispatch(`/api/repos/${repositoryId}/versions`, {
        body: JSON.stringify({
          files: [{
            content: "[printer]\nkinematics: corexy\n# must not be stored\n",
            path: "printer.cfg",
            public: false,
            role: "printer",
          }],
        }),
        headers: mutationHeaders,
        method: "POST",
      });
      assert.equal(rejectedVersion.status, 409);
      assertStorageQuota(
        await rejectedVersion.json(),
        STORAGE_RESOURCES.repositoryVersions,
        STORAGE_LIMITS.repositoryVersions,
      );
      const blobsAfterRejectedVersion = await quotaBucket.list({ prefix: "blobs/sha256/" });
      assert.deepEqual(
        blobsAfterRejectedVersion.objects.map((object) => object.key).sort(),
        blobsBeforeRejectedVersion.objects.map((object) => object.key).sort(),
      );

      await quotaDb.prepare(
        `INSERT INTO printers
           (id, user_id, name, description, make, model, source, definition_json, package_ids_json,
            variable_values_json, repository_id, latest_version_id, applied_version_id, created_at, updated_at)
         VALUES ('quota-rollback-printer', 'local-dev-user', 'Quota rollback printer', '', '', '',
                 'manual', '{}', '[]', '{}', ?, 256, 256, ?, ?)`,
      ).bind(repositoryId, timestamp, timestamp).run();
      await quotaDb.prepare(
        `INSERT INTO sync_tokens
           (id, user_id, repository_id, printer_id, name, token_hash, token_prefix,
            scopes_json, last_used_at, expires_at, created_at)
         VALUES ('quota-rollback-token', 'local-dev-user', ?, 'quota-rollback-printer',
                 'Quota rollback token', ?, 'quota-rollba', '["repo:read","repo:write"]', NULL, NULL, ?)`,
      ).bind(repositoryId, await hashToken("quota-rollback-token"), timestamp).run();
      const latestBeforeRollback = await quotaDb.prepare(
        "SELECT latest_version_id FROM repositories WHERE id = ?",
      ).bind(repositoryId).first();
      const rejectedRollback = await quotaDispatch(`/api/sync/repos/${repositoryId}/rollback`, {
        body: JSON.stringify({ versionNumber: 1 }),
        headers: {
          authorization: "Bearer quota-rollback-token",
          "content-type": "application/json",
        },
        method: "POST",
      });
      assert.equal(rejectedRollback.status, 409);
      assertStorageQuota(
        await rejectedRollback.json(),
        STORAGE_RESOURCES.repositoryVersions,
        STORAGE_LIMITS.repositoryVersions,
      );
      const latestAfterRollback = await quotaDb.prepare(
        "SELECT latest_version_id FROM repositories WHERE id = ?",
      ).bind(repositoryId).first();
      assert.equal(latestAfterRollback.latest_version_id, latestBeforeRollback.latest_version_id);

      await quotaDb.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 63
         )
         INSERT INTO private_packages
           (id, user_id, package_id, name, title, package_json, created_at, updated_at)
         SELECT 'quota-package-row-' || value, 'local-dev-user', 'quota-package-' || value,
                'quota-package-' || value, 'Quota package ' || value, '{}', ?, ?
         FROM sequence`,
      ).bind(timestamp, timestamp).run();
      await raceAtLimit([
        quotaDispatch("/api/private-packages", {
          body: JSON.stringify(packageBody("quota-package-race-a", "[printer]\n# package quota race\n")),
          headers: mutationHeaders,
          method: "POST",
        }),
        quotaDispatch("/api/private-packages", {
          body: JSON.stringify(packageBody("quota-package-race-b", "[printer]\n# package quota race\n")),
          headers: mutationHeaders,
          method: "POST",
        }),
      ], STORAGE_RESOURCES.privatePackages, STORAGE_LIMITS.privatePackages);
      const packageCount = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM private_packages WHERE user_id = 'local-dev-user'",
      ).first();
      assert.equal(packageCount.count, STORAGE_LIMITS.privatePackages);
      const updatedPackage = await quotaDispatch("/api/private-packages", {
        body: JSON.stringify(packageBody("quota-package-1", "[printer]\n# update allowed at cap\n")),
        headers: mutationHeaders,
        method: "POST",
      });
      assert.equal(updatedPackage.status, 201);

      await quotaDb.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 30
         )
         INSERT INTO printers
           (id, user_id, name, description, make, model, source, definition_json, package_ids_json,
            variable_values_json, repository_id, latest_version_id, applied_version_id, created_at, updated_at)
         SELECT 'quota-printer-' || value, 'local-dev-user', 'Quota printer ' || value,
                '', '', '', 'manual', '{}', '[]', '{}', NULL, 0, 0, ?, ?
         FROM sequence`,
      ).bind(timestamp, timestamp).run();
      const createdPrinter = await raceAtLimit([
        quotaDispatch("/api/printers", {
          body: JSON.stringify({ printer: { id: "quota-printer-race-a", name: "Quota printer race A" } }),
          headers: mutationHeaders,
          method: "POST",
        }),
        quotaDispatch("/api/printers", {
          body: JSON.stringify({ printer: { id: "quota-printer-race-b", name: "Quota printer race B" } }),
          headers: mutationHeaders,
          method: "POST",
        }),
      ], STORAGE_RESOURCES.printers, STORAGE_LIMITS.printers);
      const printerCount = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM printers WHERE user_id = 'local-dev-user'",
      ).first();
      assert.equal(printerCount.count, STORAGE_LIMITS.printers);
      const updatedPrinter = await quotaDispatch("/api/printers", {
        body: JSON.stringify({ printer: {
          id: createdPrinter.printer.id,
          name: createdPrinter.printer.name,
          description: "Updated while at quota",
        } }),
        headers: mutationHeaders,
        method: "POST",
      });
      assert.equal(updatedPrinter.status, 200);

      await quotaDb.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 63
         )
         INSERT INTO companion_assets (id, user_id, kind, title, asset_json, created_at, updated_at)
         SELECT 'quota-asset-' || value, 'local-dev-user', 'machine', 'Quota asset ' || value, '{}', ?, ?
         FROM sequence`,
      ).bind(timestamp, timestamp).run();
      const createdAsset = await raceAtLimit([
        quotaDispatch("/api/companion-assets", {
          body: JSON.stringify(assetBody("quota-asset-race-a", "Quota asset race A")),
          headers: mutationHeaders,
          method: "POST",
        }),
        quotaDispatch("/api/companion-assets", {
          body: JSON.stringify(assetBody("quota-asset-race-b", "Quota asset race B")),
          headers: mutationHeaders,
          method: "POST",
        }),
      ], STORAGE_RESOURCES.companionAssets, STORAGE_LIMITS.companionAssets);
      const assetCount = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM companion_assets WHERE user_id = 'local-dev-user'",
      ).first();
      assert.equal(assetCount.count, STORAGE_LIMITS.companionAssets);
      const updatedAsset = await quotaDispatch("/api/companion-assets", {
        body: JSON.stringify(assetBody(createdAsset.asset.id, createdAsset.asset.title)),
        headers: mutationHeaders,
        method: "POST",
      });
      assert.equal(updatedAsset.status, 200);

      await quotaDb.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 14
         )
         INSERT INTO sync_tokens
           (id, user_id, repository_id, printer_id, name, token_hash, token_prefix,
            scopes_json, last_used_at, expires_at, created_at)
         SELECT 'quota-token-' || value, 'local-dev-user', ?, NULL, 'Quota token ' || value,
                'quota-token-hash-' || value, 'quota-token', '["repo:read"]', NULL, NULL, ?
         FROM sequence`,
      ).bind(repositoryId, timestamp).run();
      await raceAtLimit([
        quotaDispatch(`/api/repos/${repositoryId}/sync-tokens`, {
          body: JSON.stringify({ name: "Quota token race A", scopes: ["repo:read"] }),
          headers: mutationHeaders,
          method: "POST",
        }),
        quotaDispatch(`/api/repos/${repositoryId}/sync-tokens`, {
          body: JSON.stringify({ name: "Quota token race B", scopes: ["repo:read"] }),
          headers: mutationHeaders,
          method: "POST",
        }),
      ], STORAGE_RESOURCES.syncTokens, STORAGE_LIMITS.syncTokens);
      const tokenCount = await quotaDb.prepare(
        "SELECT COUNT(*) AS count FROM sync_tokens WHERE repository_id = ? AND user_id = 'local-dev-user'",
      ).bind(repositoryId).first();
      assert.equal(tokenCount.count, STORAGE_LIMITS.syncTokens);
    } finally {
      await quotaMf.dispose();
    }
  });

  it("inventories and reclaims only grace-aged unreferenced canonical objects", async () => {
    const operatorHeaders = {
      authorization: `Bearer ${STORAGE_MAINTENANCE_TOKEN}`,
      "content-type": "application/json",
    };
    const unauthorized = await dispatch("/api/internal/storage/objects");
    assert.equal(unauthorized.status, 401);
    await assert.rejects(
      db.prepare(
        `INSERT INTO canonical_blob_gc_candidates
           (r2_key, sha256, first_seen_at, last_checked_at, reclaim_after)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        `blobs/sha256/${"1".repeat(64)}`,
        "2".repeat(64),
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
        "2000-01-08T00:00:00.000Z",
      ).run(),
      /CHECK constraint failed/,
    );

    const content = `[printer]\n# unreferenced reclamation ${crypto.randomUUID()}\n`;
    const hash = await sha256Hex(content);
    const key = `blobs/sha256/${hash}`;
    const size = new TextEncoder().encode(content).byteLength;
    const timestamp = new Date().toISOString();
    const bucket = await mf.getR2Bucket("BLOBS");
    await bucket.put(key, content, { customMetadata: { sha256: hash } });
    await db.batch([
      db.prepare(
        `INSERT INTO canonical_blobs
           (sha256, size_bytes, charge_bytes, created_at, stored_at)
         VALUES (?, ?, 65536, ?, ?)`,
      ).bind(hash, size, timestamp, timestamp),
      db.prepare(
        `INSERT INTO user_blob_claims
           (user_id, sha256, size_bytes, charge_bytes, created_at)
         VALUES ('user_1', ?, ?, 65536, ?)`,
      ).bind(hash, size, timestamp),
    ]);
    const charged = await db.prepare(
      `SELECT
         (SELECT charge_bytes FROM canonical_blob_budget_total WHERE id = 1) AS service_total,
         COALESCE((SELECT charge_bytes FROM user_blob_budget_totals WHERE user_id = 'user_1'), 0) AS user_total`,
    ).first();

    const objectInventory = await dispatch("/api/internal/storage/objects", { headers: operatorHeaders });
    assert.equal(objectInventory.status, 200);
    assert.equal((await objectInventory.json()).objects.some((object) => object.key === key), true);

    const planned = await dispatch("/api/internal/storage/reclaims", {
      body: JSON.stringify({ hashes: [hash] }),
      headers: operatorHeaders,
      method: "POST",
    });
    assert.equal(planned.status, 200);
    const plannedBody = await planned.json();
    assert.equal(plannedBody.results[0].status, "observing");
    assert.equal(plannedBody.results[0].objectPresent, true);

    await db.prepare(
      `UPDATE canonical_blob_gc_candidates
       SET reclaim_after = '2000-01-01T00:00:00.000Z'
       WHERE sha256 = ? AND delete_token IS NULL`,
    ).bind(hash).run();
    const reclaimed = await dispatch("/api/internal/storage/reclaims", {
      body: JSON.stringify({ apply: true, hashes: [hash] }),
      headers: operatorHeaders,
      method: "POST",
    });
    assert.equal(reclaimed.status, 200);
    assert.deepEqual((await reclaimed.json()).results[0], { hash, outcome: "deleted", status: "reclaimed" });
    assert.equal(await bucket.head(key), null);

    const after = await db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM canonical_blobs WHERE sha256 = ?) AS blobs,
         (SELECT COUNT(*) FROM user_blob_claims WHERE sha256 = ?) AS claims,
         (SELECT charge_bytes FROM canonical_blob_budget_total WHERE id = 1) AS service_total,
         COALESCE((SELECT charge_bytes FROM user_blob_budget_totals WHERE user_id = 'user_1'), 0) AS user_total,
         (SELECT state FROM canonical_blob_gc_events WHERE sha256 = ? ORDER BY started_at DESC LIMIT 1) AS event_state`,
    ).bind(hash, hash, hash).first();
    assert.deepEqual(after, {
      blobs: 0,
      claims: 0,
      event_state: "reclaimed",
      service_total: charged.service_total - 65_536,
      user_total: charged.user_total - 65_536,
    });

    const recoveryContent = `[printer]\n# recovery ${crypto.randomUUID()}\n`;
    const recoveryHash = await sha256Hex(recoveryContent);
    const recoverySize = new TextEncoder().encode(recoveryContent).byteLength;
    const recoveryKey = `blobs/sha256/${recoveryHash}`;
    const recoveryToken = crypto.randomUUID();
    await bucket.put(recoveryKey, recoveryContent, { customMetadata: { sha256: recoveryHash } });
    const recoveryObject = await bucket.head(recoveryKey);
    assert.notEqual(recoveryObject, null);
    await db.batch([
      db.prepare(
        `INSERT INTO canonical_blobs
           (sha256, size_bytes, charge_bytes, created_at, stored_at)
         VALUES (?, ?, 65536, ?, ?)`,
      ).bind(recoveryHash, recoverySize, timestamp, timestamp),
      db.prepare(
        `INSERT INTO user_blob_claims
           (user_id, sha256, size_bytes, charge_bytes, created_at)
         VALUES ('user_1', ?, ?, 65536, ?)`,
      ).bind(recoveryHash, recoverySize, timestamp),
      db.prepare(
        `INSERT INTO canonical_blob_gc_candidates
           (r2_key, sha256, first_seen_at, last_checked_at, reclaim_after,
            object_size_bytes, object_etag, object_version, object_uploaded_at,
            delete_token, delete_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        recoveryKey,
        recoveryHash,
        timestamp,
        timestamp,
        timestamp,
        recoveryObject.size,
        recoveryObject.etag,
        recoveryObject.version,
        recoveryObject.uploaded.toISOString(),
        recoveryToken,
        timestamp,
      ),
      db.prepare(
        `INSERT INTO canonical_blob_gc_events
           (id, r2_key, sha256, state, object_size_bytes, object_etag,
            object_version, object_uploaded_at, started_at)
         VALUES (?, ?, ?, 'deleting', ?, ?, ?, ?, ?)`,
      ).bind(
        recoveryToken,
        recoveryKey,
        recoveryHash,
        recoveryObject.size,
        recoveryObject.etag,
        recoveryObject.version,
        recoveryObject.uploaded.toISOString(),
        timestamp,
      ),
    ]);
    // Simulate an invocation that deleted R2 and terminated before D1 cleanup.
    await bucket.delete(recoveryKey);
    const resumed = await dispatch("/api/internal/storage/reclaims", {
      body: JSON.stringify({
        apply: true,
        hashes: [recoveryHash],
        resumeTokens: { [recoveryHash]: recoveryToken },
      }),
      headers: operatorHeaders,
      method: "POST",
    });
    assert.deepEqual((await resumed.json()).results[0], {
      hash: recoveryHash,
      outcome: "already_missing",
      status: "reclaimed",
    });
    assert.deepEqual(
      await db.prepare("SELECT state, outcome FROM canonical_blob_gc_events WHERE id = ?")
        .bind(recoveryToken)
        .first(),
      { outcome: "already_missing", state: "reclaimed" },
    );

    const serializedContent = `[printer]\n# serialized reclaim ${crypto.randomUUID()}\n`;
    const serializedHash = await sha256Hex(serializedContent);
    const serializedKey = `blobs/sha256/${serializedHash}`;
    const serializedSize = new TextEncoder().encode(serializedContent).byteLength;
    const serializedToken = crypto.randomUUID();
    await bucket.put(serializedKey, serializedContent, { customMetadata: { sha256: serializedHash } });
    const serializedObject = await bucket.head(serializedKey);
    assert.notEqual(serializedObject, null);
    await db.batch([
      db.prepare(
        `INSERT INTO canonical_blobs
           (sha256, size_bytes, charge_bytes, created_at, stored_at)
         VALUES (?, ?, 65536, ?, ?)`,
      ).bind(serializedHash, serializedSize, timestamp, timestamp),
      db.prepare(
        `INSERT INTO user_blob_claims
           (user_id, sha256, size_bytes, charge_bytes, created_at)
         VALUES ('user_1', ?, ?, 65536, ?)`,
      ).bind(serializedHash, serializedSize, timestamp),
      db.prepare(
        `INSERT INTO canonical_blob_gc_candidates
           (r2_key, sha256, first_seen_at, last_checked_at, reclaim_after,
            object_size_bytes, object_etag, object_version, object_uploaded_at,
            delete_token, delete_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        serializedKey,
        serializedHash,
        timestamp,
        timestamp,
        timestamp,
        serializedObject.size,
        serializedObject.etag,
        serializedObject.version,
        serializedObject.uploaded.toISOString(),
        serializedToken,
        timestamp,
      ),
      db.prepare(
        `INSERT INTO canonical_blob_gc_events
           (id, r2_key, sha256, state, object_size_bytes, object_etag,
            object_version, object_uploaded_at, started_at)
         VALUES (?, ?, ?, 'deleting', ?, ?, ?, ?, ?)`,
      ).bind(
        serializedToken,
        serializedKey,
        serializedHash,
        serializedObject.size,
        serializedObject.etag,
        serializedObject.version,
        serializedObject.uploaded.toISOString(),
        timestamp,
      ),
    ]);
    const reclaimBody = JSON.stringify({
      apply: true,
      hashes: [serializedHash],
      resumeTokens: { [serializedHash]: serializedToken },
    });
    const reclaimGate = armReclaimHook(serializedHash);
    const firstResume = dispatch("/api/internal/storage/reclaims", {
      body: reclaimBody,
      headers: operatorHeaders,
      method: "POST",
    });
    await reclaimGate.reached;
    const secondResume = dispatch("/api/internal/storage/reclaims", {
      body: reclaimBody,
      headers: operatorHeaders,
      method: "POST",
    });
    await reclaimGate.queued;
    await new Promise((resolve) => setImmediate(resolve));
    const overlappingHookCalls = reclaimHookState.afterHeadCalls;
    reclaimGate.release();
    assert.equal(overlappingHookCalls, 1);
    const serializedResults = await Promise.all(
      [firstResume, secondResume].map(async (responsePromise) => (
        (await (await responsePromise).json()).results[0].status
      )),
    );
    clearReclaimHook();
    assert.deepEqual(serializedResults.sort(), ["not_found", "reclaimed"]);

    const replacement = await dispatch("/api/repos", {
      body: JSON.stringify({
        files: [{ content: serializedContent, path: "printer.cfg", public: false, role: "printer" }],
        title: `Post-reclaim replacement ${crypto.randomUUID()}`,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(replacement.status, 201);
    assert.notEqual(await bucket.head(serializedKey), null);
  });

  it("blocks reclamation during writes and blocks writers behind a deletion fence", async () => {
    const operatorHeaders = {
      authorization: `Bearer ${STORAGE_MAINTENANCE_TOKEN}`,
      "content-type": "application/json",
    };
    const timestamp = new Date().toISOString();
    const leasedContent = `[printer]\n# active lease ${crypto.randomUUID()}\n`;
    const leasedHash = await sha256Hex(leasedContent);
    const leasedSize = new TextEncoder().encode(leasedContent).byteLength;
    await db.batch([
      db.prepare(
        `INSERT INTO canonical_blobs
           (sha256, size_bytes, charge_bytes, created_at, stored_at)
         VALUES (?, ?, 65536, ?, ?)`,
      ).bind(leasedHash, leasedSize, timestamp, timestamp),
      db.prepare(
        `INSERT INTO user_blob_claims
           (user_id, sha256, size_bytes, charge_bytes, created_at)
         VALUES ('user_1', ?, ?, 65536, ?)`,
      ).bind(leasedHash, leasedSize, timestamp),
      db.prepare(
        `INSERT INTO canonical_blob_write_leases
           (lease_id, user_id, sha256, created_at, expires_at)
         VALUES (?, 'user_1', ?, ?, '2999-01-01T00:00:00.000Z')`,
      ).bind(crypto.randomUUID(), leasedHash, timestamp),
    ]);
    const leasedPlan = await dispatch("/api/internal/storage/reclaims", {
      body: JSON.stringify({ hashes: [leasedHash] }),
      headers: operatorHeaders,
      method: "POST",
    });
    assert.equal((await leasedPlan.json()).results[0].status, "write_in_progress");
    await db.batch([
      db.prepare("DELETE FROM canonical_blob_write_leases WHERE sha256 = ?").bind(leasedHash),
      db.prepare("DELETE FROM user_blob_claims WHERE sha256 = ?").bind(leasedHash),
      db.prepare("DELETE FROM canonical_blobs WHERE sha256 = ?").bind(leasedHash),
    ]);

    const cancellationContent = `[printer]\n# candidate cancellation ${crypto.randomUUID()}\n`;
    const cancellationHash = await sha256Hex(cancellationContent);
    await db.prepare(
      `INSERT INTO canonical_blob_gc_candidates
         (r2_key, sha256, first_seen_at, last_checked_at, reclaim_after)
       VALUES (?, ?, ?, ?, '2999-01-01T00:00:00.000Z')`,
    ).bind(
      `blobs/sha256/${cancellationHash}`,
      cancellationHash,
      timestamp,
      timestamp,
    ).run();
    const cancellationSave = await dispatch("/api/repos", {
      body: JSON.stringify({
        files: [{ content: cancellationContent, path: "printer.cfg", public: false, role: "printer" }],
        title: `Candidate cancellation ${crypto.randomUUID()}`,
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(cancellationSave.status, 201);
    assert.deepEqual(
      await db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM canonical_blob_gc_candidates WHERE sha256 = ?) AS candidates,
           (SELECT COUNT(*) FROM canonical_blob_references WHERE sha256 = ?) AS refs,
           (SELECT COUNT(*) FROM canonical_blob_write_leases WHERE sha256 = ?) AS leases`,
      ).bind(cancellationHash, cancellationHash, cancellationHash).first(),
      { candidates: 0, leases: 0, refs: 1 },
    );

    const content = `[printer]\n# fenced write ${crypto.randomUUID()}\n`;
    const hash = await sha256Hex(content);
    const key = `blobs/sha256/${hash}`;
    const deletionToken = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO canonical_blob_gc_candidates
         (r2_key, sha256, first_seen_at, last_checked_at, reclaim_after,
          delete_token, delete_started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(key, hash, timestamp, timestamp, timestamp, deletionToken, timestamp).run();

    const create = await dispatch("/api/repos", {
      body: JSON.stringify({ empty: true, title: `Fenced repo ${crypto.randomUUID()}` }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const created = await create.json();
    assert.equal(create.status, 201);
    const write = await dispatch(`/api/repos/${created.repository.id}/versions`, {
      body: JSON.stringify({
        files: [{ content, path: "printer.cfg", public: false, role: "printer" }],
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(write.status, 503);
    assert.deepEqual(await write.json(), {
      code: "canonical_blob_reclamation_in_progress",
      error: "Cloud file storage maintenance is finishing. Retry shortly.",
      resource: "canonical-file-bodies",
    });
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS count FROM canonical_blobs WHERE sha256 = ?").bind(hash).first()).count,
      0,
    );

    const inProgress = await dispatch("/api/internal/storage/reclaims", {
      body: JSON.stringify({ apply: true, hashes: [hash] }),
      headers: operatorHeaders,
      method: "POST",
    });
    assert.equal((await inProgress.json()).results[0].status, "deletion_in_progress");
    await db.prepare("DELETE FROM canonical_blob_gc_candidates WHERE r2_key = ? AND delete_token = ?")
      .bind(key, deletionToken)
      .run();
  });

  it("reaps legacy rendered ZIPs and expired auth records on the scheduled cron (#279)", async () => {
    const bucket = await mf.getR2Bucket("BLOBS");
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
    const expiredKey = "artifacts/rendered-zips/sha256/expired-cron-fixture.zip";
    const freshKey = "artifacts/rendered-zips/sha256/fresh-cron-fixture.zip";
    await bucket.put(expiredKey, zipBytes, {
      customMetadata: { artifactType: "rendered-zip", expiresAt: "2000-01-01T00:00:00.000Z" },
    });
    await bucket.put(freshKey, zipBytes, {
      customMetadata: { artifactType: "rendered-zip", expiresAt: "2999-01-01T00:00:00.000Z" },
    });
    await db.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (1)
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 105
       )
       INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at)
       SELECT 'expired-cron-session-' || value, 'user_2', 'expired-cron-session-hash-' || value,
              '2000-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z'
       FROM sequence`,
    ).run();
    await db.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (1)
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 105
       )
       INSERT INTO oauth_states (id, provider, redirect_to, expires_at, created_at)
       SELECT 'expired-cron-oauth-' || value, 'github', '/',
              '2000-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z'
       FROM sequence`,
    ).run();
    await db.prepare(
      `INSERT INTO oauth_states (id, provider, redirect_to, expires_at, created_at)
       VALUES ('active-cron-oauth', 'github', '/', '2999-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const scheduled = await (await mf.getWorker()).scheduled({
      cron: "0 3 * * *",
      scheduledTime: new Date("2026-08-05T03:00:00.000Z"),
    });
    assert.equal(scheduled.outcome, "ok");

    const [expiredSessions, expiredStates] = await Promise.all([
      db.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE id LIKE 'expired-cron-session-%'",
      ).first(),
      db.prepare(
        "SELECT COUNT(*) AS count FROM oauth_states WHERE id LIKE 'expired-cron-oauth-%'",
      ).first(),
    ]);
    assert.equal(await bucket.head(expiredKey), null);
    assert.equal(expiredSessions.count, 0);
    assert.equal(expiredStates.count, 0);
    assert.notEqual(await bucket.head(freshKey), null);
    assert.notEqual(await db.prepare("SELECT id FROM sessions WHERE id = 'session_2'").first(), null);
    assert.notEqual(await db.prepare("SELECT id FROM oauth_states WHERE id = 'active-cron-oauth'").first(), null);
  });

  it("continues scheduled maintenance after a missing-table failure and reports the failed run", async () => {
    const failureMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: { APP_ORIGIN: WORKER_ORIGIN, SESSION_SECRET },
      d1Databases: { DB: "klippee-cron-isolation-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-cron-isolation-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const failureDb = await failureMf.getD1Database("DB");
      const failureBucket = await failureMf.getR2Bucket("BLOBS");
      const expiredKey = "artifacts/rendered-zips/sha256/cron-isolation-expired.zip";
      const leaseHash = "a".repeat(64);
      await applyMigrations(failureDb);
      // Reproduce the incident #303 failure shape: D1 is available and its
      // migration ledger is current, but one cleanup table is unavailable.
      await failureDb.prepare("DROP TABLE sessions").run();
      await failureDb.prepare(
        `INSERT INTO oauth_states (id, provider, redirect_to, expires_at, created_at)
         VALUES ('later-expired-oauth-state', 'github', '/',
                 '2000-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z')`,
      ).run();
      await failureDb.prepare(
        `INSERT INTO canonical_blobs
         (sha256, size_bytes, charge_bytes, created_at, stored_at)
         VALUES (?, 1, 65536, '1999-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z')`,
      ).bind(leaseHash).run();
      await failureDb.prepare(
        `INSERT INTO canonical_blob_write_leases
         (lease_id, user_id, sha256, created_at, expires_at)
         VALUES ('later-expired-lease', 'cron-isolation-user', ?,
                 '1999-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
      ).bind(leaseHash).run();
      await failureBucket.put(expiredKey, new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
        customMetadata: { artifactType: "rendered-zip", expiresAt: "2000-01-01T00:00:00.000Z" },
      });

      const scheduled = await (await failureMf.getWorker()).scheduled({
        cron: "0 3 * * *",
        scheduledTime: new Date("2026-08-05T03:00:00.000Z"),
      });
      assert.equal(scheduled.outcome, "exception");
      assert.equal(
        await failureDb.prepare(
          "SELECT id FROM oauth_states WHERE id = 'later-expired-oauth-state'",
        ).first(),
        null,
      );
      assert.equal(await failureBucket.head(expiredKey), null);
      assert.equal(
        await failureDb.prepare(
          "SELECT lease_id FROM canonical_blob_write_leases WHERE lease_id = 'later-expired-lease'",
        ).first(),
        null,
      );
    } finally {
      await failureMf.dispose();
    }
  });
});
