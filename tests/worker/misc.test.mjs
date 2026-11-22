import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Miniflare } from "./miniflare.mjs";
import {
  SESSION_SECRET,
  WORKER_ORIGIN,
  applyMigration,
  applyMigrations,
  bootSharedWorker,
  dispatch,
  disposeSharedWorker,
} from "./helpers.mjs";

describe("worker API smoke: misc", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("reports healthy required Cloudflare bindings", async () => {
    const response = await dispatch("/api/health");
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.checks, {
      d1: true,
      d1Schema: true,
      r2: true,
    });
    assert.equal(body.service, "klippee");
  });

  it("reports an available but unmigrated D1 schema as unhealthy", async () => {
    const schemaMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: { APP_ORIGIN: WORKER_ORIGIN, SESSION_SECRET },
      d1Databases: { DB: "klippee-health-schema-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-health-schema-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const schemaDb = await schemaMf.getD1Database("DB");
      await applyMigrations(schemaDb, "0022_canonical_blob_reclamation.sql");

      const outdated = await schemaMf.dispatchFetch(new URL("/api/health", WORKER_ORIGIN));
      const outdatedBody = await outdated.json();
      assert.equal(outdated.status, 503);
      assert.equal(outdatedBody.ok, false);
      assert.deepEqual(outdatedBody.checks, {
        d1: true,
        d1Schema: false,
        r2: true,
      });

      await schemaDb.prepare("INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')").run();
      const futureOnly = await schemaMf.dispatchFetch(new URL("/api/health", WORKER_ORIGIN));
      assert.equal(futureOnly.status, 503);
      assert.equal((await futureOnly.json()).checks.d1Schema, false);

      await applyMigration(schemaDb, "0023_oauth_pkce.sql");
      const stillOutdated = await schemaMf.dispatchFetch(new URL("/api/health", WORKER_ORIGIN));
      assert.equal(stillOutdated.status, 503);
      await applyMigration(schemaDb, "0024_orca_setups.sql");
      await applyMigration(schemaDb, "0025_orca_profile_library.sql");
      await applyMigration(schemaDb, "0026_orca_devices.sql");
      await applyMigration(schemaDb, "0027_orca_device_uploads.sql");
      await applyMigration(schemaDb, "0028_public_package_auto_updates.sql");
      await applyMigration(schemaDb, "0029_orca_publication_updates.sql");
      const withoutHistoryIndex = await schemaMf.dispatchFetch(new URL("/api/health", WORKER_ORIGIN));
      assert.equal(withoutHistoryIndex.status, 503);
      assert.equal((await withoutHistoryIndex.json()).checks.d1Schema, false);
      await applyMigration(schemaDb, "0030_repository_history_reference_index.sql");
      const currentWithFuture = await schemaMf.dispatchFetch(new URL("/api/health", WORKER_ORIGIN));
      const currentWithFutureBody = await currentWithFuture.json();
      assert.equal(currentWithFuture.status, 200);
      assert.equal(currentWithFutureBody.ok, true);
      assert.deepEqual(currentWithFutureBody.checks, {
        d1: true,
        d1Schema: true,
        r2: true,
      });
    } finally {
      await schemaMf.dispose();
    }
  });

  it("does not expose the removed STL API", async () => {
    const response = await dispatch("/api/stl/health");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  });

  it("serves stateless CAD without forwarding authentication", async () => {
    const forwarded = [];
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: WORKER_ORIGIN,
        CAD_API_BASE: "https://cad.example",
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-cad-proxy-test" },
      modules: true,
      outboundService(request) {
        forwarded.push(request);
        if (new URL(request.url).pathname === "/api/fail") {
          return Response.json({ detail: "internal container path: /srv/cad/private.py" }, { status: 500 });
        }
        return Response.json({ ok: true, storage: "none" });
      },
      r2Buckets: { BLOBS: "klippee-cad-proxy-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const response = await tempMf.dispatchFetch(new URL("/api/cad/health", WORKER_ORIGIN), {
        headers: {
          authorization: "Bearer secret",
          cookie: "__Host-klippee_session=session",
          origin: WORKER_ORIGIN,
        },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.storage, "none");
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0].headers.get("authorization"), null);
      assert.equal(forwarded[0].headers.get("cookie"), null);
      assert.equal(new URL(forwarded[0].url).pathname, "/api/health");

      const failed = await tempMf.dispatchFetch(new URL("/api/cad/fail", WORKER_ORIGIN));
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: "CAD service unavailable" });

      const chunked = await tempMf.dispatchFetch(new URL("/api/cad/render", WORKER_ORIGIN), {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          },
        }),
        duplex: "half",
        headers: {
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });
      assert.equal(chunked.status, 411);
      assert.deepEqual(await chunked.json(), { error: "CAD requests with a body require Content-Length" });
      assert.equal(forwarded.length, 2);
    } finally {
      await tempMf.dispose();
    }
  });

  it("imports a bounded public SCAD URL without sending it to the CAD container", async () => {
    const fetched = [];
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: WORKER_ORIGIN,
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-scad-import-test" },
      modules: true,
      outboundService(request) {
        fetched.push(request.url);
        return new Response("size = 12;\ncube(size);", {
          headers: {
            "content-length": "22",
            "content-type": "text/plain",
          },
        });
      },
      r2Buckets: { BLOBS: "klippee-scad-import-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const response = await tempMf.dispatchFetch(new URL("/api/cad/import-scad", WORKER_ORIGIN), {
        body: JSON.stringify({ url: "https://models.example/fixtures/demo.scad" }),
        headers: {
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body.files, [{ name: "demo.scad", source: "size = 12;\ncube(size);" }]);
      assert.equal(body.mainFile, "demo.scad");
      assert.deepEqual(fetched, ["https://models.example/fixtures/demo.scad"]);
    } finally {
      await tempMf.dispose();
    }
  });

  it("imports SCAD projects with up to sixty-four files", async () => {
    const acceptedEntries = Array.from({ length: 64 }, (_, index) => ({
      path: `accepted/model-${String(index).padStart(2, "0")}.scad`,
      size: 8,
      type: "blob",
    }));
    const rejectedEntries = Array.from({ length: 65 }, (_, index) => ({
      path: `rejected/model-${String(index).padStart(2, "0")}.scad`,
      size: 8,
      type: "blob",
    }));
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: WORKER_ORIGIN,
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-scad-project-import-test" },
      modules: true,
      outboundService(request) {
        const url = new URL(request.url);
        if (url.hostname === "api.github.com") {
          return Response.json({ tree: [...acceptedEntries, ...rejectedEntries], truncated: false });
        }
        if (url.hostname === "raw.githubusercontent.com") {
          return new Response("cube(1);", {
            headers: { "content-length": "8", "content-type": "text/plain" },
          });
        }
        return new Response("Unexpected outbound request", { status: 500 });
      },
      r2Buckets: { BLOBS: "klippee-scad-project-import-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const accepted = await tempMf.dispatchFetch(new URL("/api/cad/import-scad", WORKER_ORIGIN), {
        body: JSON.stringify({ url: "https://github.com/klippee/fixtures/tree/main/accepted" }),
        headers: {
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });
      const acceptedBody = await accepted.json();
      assert.equal(accepted.status, 200);
      assert.equal(acceptedBody.files.length, 64);
      assert.equal(acceptedBody.mainFile, "model-00.scad");

      const rejected = await tempMf.dispatchFetch(new URL("/api/cad/import-scad", WORKER_ORIGIN), {
        body: JSON.stringify({ url: "https://github.com/klippee/fixtures/tree/main/rejected" }),
        headers: {
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });
      assert.equal(rejected.status, 413);
      assert.match((await rejected.json()).error, /at most 64/);
    } finally {
      await tempMf.dispose();
    }
  });

  it("rejects private or insecure SCAD import URLs before fetching them", async () => {
    for (const url of [
      "http://models.example/demo.scad",
      "https://127.0.0.1/demo.scad",
      "https://[::ffff:127.0.0.1]/demo.scad",
      "https://printer.local/demo.scad",
      // #281: public IP literals and the trailing-dot loopback form must also be
      // rejected — a real public domain always ends in an alphabetic label.
      "https://8.8.8.8/demo.scad",
      "https://127.0.0.1./demo.scad",
      "https://169.254.169.254/latest/meta-data/demo.scad",
      "https://2130706433/demo.scad",
    ]) {
      const response = await dispatch("/api/cad/import-scad", {
        body: JSON.stringify({ url }),
        headers: {
          "content-type": "application/json",
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Only public HTTPS URLs are supported." });
    }
  });
});
