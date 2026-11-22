import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Miniflare } from "./miniflare.mjs";
import {
  SESSION_SECRET,
  SESSION_TOKEN,
  WORKER_ORIGIN,
  applyMigration,
  applyMigrations,
  base64Url,
  bootSharedWorker,
  cookieValue,
  db,
  dispatch,
  disposeSharedWorker,
  hashToken,
} from "./helpers.mjs";

describe("worker API smoke: auth", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("returns an anonymous user when no session cookie is present", async () => {
    const response = await dispatch("/api/auth/me");
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { user: null });
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  it("uses a local development user on localhost without a session cookie", async () => {
    const authResponse = await dispatch("http://localhost:5173/api/auth/me");
    const authBody = await authResponse.json();

    assert.equal(authResponse.status, 200);
    assert.deepEqual(authBody.user, {
      avatarUrl: null,
      displayName: "Local Developer",
      id: "local-dev-user",
      providers: ["github"],
    });

    const privateResponse = await dispatch("http://localhost:5173/api/repos");
    const privateBody = await privateResponse.json();

    assert.equal(privateResponse.status, 200);
    assert.deepEqual(privateBody, { repositories: [] });
  });

  it("does not enable local auth bypass from APP_ORIGIN alone", async () => {
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: "http://localhost:5173",
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-local-origin-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-local-origin-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      await applyMigrations(await tempMf.getD1Database("DB"));
      const response = await tempMf.dispatchFetch(new URL("/api/repos", WORKER_ORIGIN));
      const body = await response.json();

      assert.equal(response.status, 401);
      assert.deepEqual(body, { error: "Authentication required" });
    } finally {
      await tempMf.dispose();
    }
  });

  it("persists private writes for the local development user", async () => {
    const response = await dispatch("http://localhost:5173/api/printers", {
      body: JSON.stringify({
        printer: {
          id: "local_printer_1",
          name: "Local Printer",
          packageIds: [],
          source: "manual",
        },
      }),
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
      },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.printer.id, "local_printer_1");
    assert.equal(body.printer.name, "Local Printer");

    const listResponse = await dispatch("http://localhost:5173/api/printers");
    const listBody = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(listBody.printers.length, 1);
    assert.equal(listBody.printers[0].id, "local_printer_1");
  });

  it("keeps legacy OAuth state rollout compatible but constrains new PKCE verifiers", async () => {
    const migrationMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      d1Databases: { DB: "klippee-oauth-pkce-migration-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-oauth-pkce-migration-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const migrationDb = await migrationMf.getD1Database("DB");
      await applyMigrations(migrationDb, "0022_canonical_blob_reclamation.sql");
      await migrationDb.prepare(
        `INSERT INTO oauth_states (id, provider, redirect_to, expires_at, created_at)
         VALUES ('legacy-oauth-state', 'github', '/',
                 '2099-01-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z')`,
      ).run();

      await applyMigration(migrationDb, "0023_oauth_pkce.sql");

      const columns = await migrationDb.prepare("PRAGMA table_info(oauth_states)").all();
      const legacy = await migrationDb.prepare(
        "SELECT id, pkce_verifier FROM oauth_states WHERE id = 'legacy-oauth-state'",
      ).first();
      assert.equal(columns.results.some((column) => column.name === "pkce_verifier"), true);
      assert.deepEqual(legacy, { id: "legacy-oauth-state", pkce_verifier: null });
      await assert.rejects(
        migrationDb.prepare(
          `INSERT INTO oauth_states
           (id, provider, redirect_to, expires_at, created_at, pkce_verifier)
           VALUES ('malformed-pkce-state', 'github', '/',
                   '2099-01-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z', 'too-short')`,
        ).run(),
        /CHECK constraint failed/i,
      );
    } finally {
      await migrationMf.dispose();
    }
  });

  it("returns linked providers for the signed in user", async () => {
    const response = await dispatch("/api/auth/me", {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.user, {
      avatarUrl: null,
      displayName: "Test User",
      id: "user_1",
      providers: ["github"],
    });
  });

  it("expires the browser session cookie when server-side logout cleanup fails", async () => {
    const logoutMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: { APP_ORIGIN: WORKER_ORIGIN, SESSION_SECRET },
      d1Databases: { DB: "klippee-logout-cleanup-failure-test" },
      modules: true,
      r2Buckets: { BLOBS: "klippee-logout-cleanup-failure-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const response = await logoutMf.dispatchFetch(new URL("/api/auth/logout", WORKER_ORIGIN), {
        headers: {
          cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
          origin: WORKER_ORIGIN,
        },
        method: "POST",
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.match(response.headers.get("set-cookie") ?? "", /__Host-klippee_session=;/);
      assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
    } finally {
      await logoutMf.dispose();
    }
  });

  it("revokes the server session and expires the cookie on successful logout", async () => {
    const logoutToken = "logout_success_session_token";
    const logoutHash = await hashToken(logoutToken);
    await db.prepare(
      `INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at)
       VALUES ('logout_success_session', 'user_1', ?, '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(logoutHash, new Date().toISOString()).run();

    const response = await dispatch("/api/auth/logout", {
      headers: {
        cookie: `__Host-klippee_session=${logoutToken}`,
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.match(response.headers.get("set-cookie") ?? "", /__Host-klippee_session=;/);
    assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(
      await db.prepare("SELECT id FROM sessions WHERE session_hash = ?").bind(logoutHash).first(),
      null,
    );

    const authenticated = await dispatch("/api/auth/me", {
      headers: { cookie: `__Host-klippee_session=${logoutToken}` },
    });
    assert.deepEqual(await authenticated.json(), { user: null });
  });

  it("rejects anonymous access to private browser APIs", async () => {
    for (const path of ["/api/repos", "/api/printers", "/api/private-packages", "/api/companion-assets", "/api/app-state"]) {
      const response = await dispatch(path);
      const body = await response.json();

      assert.equal(response.status, 401);
      assert.deepEqual(body, { error: "Authentication required" });
    }
  });

  it("rejects app-state payloads whose encoded byte length exceeds the limit", async () => {
    const body = JSON.stringify({
      state: {
        workspaceDrafts: {
          "printer.cfg": "€".repeat(260_000),
        },
      },
    });

    assert.equal(body.length < 512_000, true);
    const bodyBytes = new TextEncoder().encode(body);
    assert.equal(bodyBytes.byteLength > 512_000, true);

    const response = await dispatch("/api/app-state", {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bodyBytes.subarray(0, 512_000));
          controller.enqueue(bodyBytes.subarray(512_000, 512_001));
          controller.close();
        },
      }),
      duplex: "half",
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "PUT",
    });
    const responseBody = await response.json();

    assert.equal(response.status, 413);
    assert.deepEqual(responseBody, { error: "State payload is too large" });
  });

  it("removes host-local variable values from stored and legacy app state", async () => {
    const secretSentinel = "never-store-this-secret";
    const requestState = {
      printer: { id: "printer_1", name: "Bench printer" },
      printers: [
        {
          id: "printer_1",
          name: "Bench printer",
          variableValues: { api_token: secretSentinel, nozzle: "0.4" },
        },
      ],
      values: { api_token: secretSentinel, nozzle: "0.4" },
      workspaceDrafts: { "printer.cfg": "[printer]\nkinematics: cartesian\n" },
    };
    const mutationHeaders = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };

    const saved = await dispatch("/api/app-state", {
      body: JSON.stringify({ expectedRevision: null, state: requestState }),
      headers: mutationHeaders,
      method: "PUT",
    });
    assert.equal(saved.status, 200);

    let row = await db.prepare(
      "SELECT state_json FROM user_app_state WHERE user_id = 'user_1'",
    ).first();
    let stored = JSON.parse(row.state_json);
    assert.equal(stored.storageFormat, "content-addressed-v1");
    assert.equal(row.state_json.includes(secretSentinel), false);

    await db.prepare(
      "UPDATE user_app_state SET state_json = ? WHERE user_id = 'user_1'",
    ).bind(JSON.stringify(requestState)).run();

    const loaded = await dispatch("/api/app-state", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const loadedBody = await loaded.json();
    assert.equal(loaded.status, 200);
    assert.equal(Object.hasOwn(loadedBody.state, "values"), false);
    assert.equal(Object.hasOwn(loadedBody.state.printers[0], "variableValues"), false);
    assert.deepEqual(loadedBody.state.workspaceDrafts, requestState.workspaceDrafts);

    row = await db.prepare(
      "SELECT state_json FROM user_app_state WHERE user_id = 'user_1'",
    ).first();
    stored = JSON.parse(row.state_json);
    assert.equal(stored.storageFormat, "content-addressed-v1");
    assert.equal(row.state_json.includes(secretSentinel), false);
  });

  it("deduplicates repeated app-state content and preserves arbitrary JSON keys", async () => {
    const repeated = "π workspace content\n".repeat(40);
    const state = JSON.parse(JSON.stringify({
      metadata: { storageFormat: "a user field", nullValue: null },
      workspaceContent: repeated,
      workspaceDrafts: { "printer.cfg": repeated },
      special: JSON.parse('{"__proto__":{"safe":true},"$klippeeContentRef":"user data"}'),
    }));
    const current = await dispatch("/api/app-state", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const currentState = await current.json();
    const response = await dispatch("/api/app-state", {
      body: JSON.stringify({ expectedRevision: currentState.revision, state }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "PUT",
    });
    assert.equal(response.status, 200);

    const row = await db.prepare("SELECT state_json FROM user_app_state WHERE user_id = 'user_1'").first();
    const encoded = JSON.parse(row.state_json);
    assert.equal(encoded.storageFormat, "content-addressed-v1");
    assert.equal(Object.keys(encoded.blobs).length, 1);
    assert.equal(Object.values(encoded.blobs)[0], repeated);

    const loaded = await dispatch("/api/app-state", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    assert.deepEqual((await loaded.json()).state, state);
  });

  it("guards app-state saves with a primary-row revision compare-and-swap", async () => {
    const current = await dispatch("/api/app-state", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const currentState = await current.json();
    assert.equal(typeof currentState.revision, "string");

    const headers = {
      cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      origin: WORKER_ORIGIN,
    };
    const contenders = await Promise.all(["first", "second"].map((selected) => dispatch("/api/app-state", {
      body: JSON.stringify({ expectedRevision: currentState.revision, state: { selected } }),
      headers,
      method: "PUT",
    })));
    const contenderBodies = await Promise.all(contenders.map((response) => response.json()));
    assert.deepEqual(contenders.map((response) => response.status).sort(), [200, 409]);
    const winnerIndex = contenders.findIndex((response) => response.status === 200);
    const winner = ["first", "second"][winnerIndex];
    assert.equal(typeof contenderBodies[winnerIndex].revision, "string");
    assert.equal(contenderBodies[1 - winnerIndex].code, "app_state_conflict");

    const missingRevision = await dispatch("/api/app-state", {
      body: JSON.stringify({ state: { selected: "legacy-client" } }),
      headers,
      method: "PUT",
    });
    assert.equal(missingRevision.status, 409);
    assert.equal((await missingRevision.json()).code, "app_state_conflict");

    const loaded = await dispatch("/api/app-state", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    assert.deepEqual((await loaded.json()).state, { selected: winner });
  });

  it("returns null for malformed content-addressed app-state snapshots", async () => {
    const malformed = {
      blobs: {},
      state: { $klippeeContentRef: "a".repeat(64) },
      storageFormat: "content-addressed-v1",
    };
    await db.prepare(
      `INSERT INTO user_app_state (user_id, state_json, updated_at)
       VALUES ('user_1', ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(malformed)).run();

    const response = await dispatch("/api/app-state", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, null);
  });

  it("continues returning valid legacy state beyond the new codec complexity limit", async () => {
    let nested = { leaf: true };
    for (let index = 0; index < 60; index += 1) nested = { child: nested };
    const legacy = { nested };
    await db.prepare(
      `INSERT INTO user_app_state (user_id, state_json, updated_at)
       VALUES ('user_1', ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(legacy)).run();

    const response = await dispatch("/api/app-state", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).state, legacy);
  });

  it("rejects streamed JSON bodies that exceed the limit without a Content-Length header", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2_048));
        controller.enqueue(new Uint8Array(2_049));
        controller.close();
      },
    });

    const response = await dispatch("/api/cad/import-scad", {
      body,
      duplex: "half",
      headers: {
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "The import request is too large." });
  });

  it("binds OAuth callback state and an S256 challenge to the initiating browser", async () => {
    for (const provider of ["github", "discord"]) {
      const start = await dispatch(`/api/auth/${provider}/start?redirect_to=/printers`, {
        redirect: "manual",
      });
      const location = new URL(start.headers.get("location"));
      const state = location.searchParams.get("state");
      const setCookie = start.headers.get("set-cookie") ?? "";
      const stateRow = await db.prepare(
        "SELECT pkce_verifier FROM oauth_states WHERE id = ?",
      ).bind(state).first();
      const verifierDigest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stateRow.pkce_verifier),
      );

      assert.equal(start.status, 302);
      assert.equal(location.origin, provider === "github" ? "https://github.com" : "https://discord.com");
      assert.equal(typeof state, "string");
      assert.match(stateRow.pkce_verifier, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(stateRow.pkce_verifier, state);
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.equal(location.searchParams.get("code_challenge"), base64Url(verifierDigest));
      assert.equal(location.searchParams.has("code_verifier"), false);
      assert.equal(location.href.includes(stateRow.pkce_verifier), false);
      assert.equal(setCookie.includes(stateRow.pkce_verifier), false);
      assert.equal(cookieValue(setCookie, "__Host-klippee_oauth_state"), state);

      const missingCookie = await dispatch(`/api/auth/${provider}/callback?code=test-code&state=${state}`, {
        redirect: "manual",
      });
      assert.equal(missingCookie.status, 302);
      assert.equal(missingCookie.headers.get("location"), `${WORKER_ORIGIN}/?auth=invalid-state`);
      assert.match(missingCookie.headers.get("set-cookie") ?? "", /__Host-klippee_oauth_state=;/);
    }
  });

  it("keeps OAuth return redirects on the application origin", async () => {
    const start = await dispatch("/api/auth/github/start?redirect_to=/%5C%5Cevil.example", {
      redirect: "manual",
    });
    const location = new URL(start.headers.get("location"));
    const state = location.searchParams.get("state");
    const stateRow = await db
      .prepare("SELECT redirect_to FROM oauth_states WHERE id = ?")
      .bind(state)
      .first();

    assert.equal(start.status, 302);
    assert.equal(location.origin, "https://github.com");
    assert.equal(stateRow.redirect_to, "/");
  });

  it("reaps expired OAuth states in a bounded batch when starting sign-in", async () => {
    await db.prepare(
      `WITH RECURSIVE expired_states(value) AS (
         VALUES (1)
         UNION ALL
         SELECT value + 1 FROM expired_states WHERE value < 105
       )
       INSERT INTO oauth_states (id, provider, redirect_to, expires_at, created_at)
       SELECT 'expired-oauth-state-' || value, 'github', '/', '2000-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z'
       FROM expired_states`,
    ).run();
    await db.prepare(
      `INSERT INTO oauth_states (id, provider, redirect_to, expires_at, created_at)
       VALUES ('active-oauth-state-fixture', 'github', '/', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const start = await dispatch("/api/auth/github/start", { redirect: "manual" });
    const expired = await db.prepare(
      "SELECT COUNT(*) AS count FROM oauth_states WHERE expires_at <= '2000-01-01T00:00:00.000Z'",
    ).first();
    const active = await db.prepare(
      "SELECT id FROM oauth_states WHERE id = 'active-oauth-state-fixture'",
    ).first();

    assert.equal(start.status, 302);
    assert.equal(expired.count, 5);
    assert.equal(active.id, "active-oauth-state-fixture");
  });

  it("rate-limits OAuth state creation by client IP", async () => {
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: WORKER_ORIGIN,
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-oauth-ratelimit-test" },
      modules: true,
      ratelimits: {
        AUTH_RATE_LIMITER: { namespace_id: "test-oauth", simple: { limit: 2, period: 60 } },
      },
      r2Buckets: { BLOBS: "klippee-oauth-ratelimit-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const tempDb = await tempMf.getD1Database("DB");
      await applyMigrations(tempDb);
      const start = () => tempMf.dispatchFetch(new URL("/api/auth/github/start", WORKER_ORIGIN), {
        headers: { "cf-connecting-ip": "203.0.113.24" },
        redirect: "manual",
      });

      const first = await start();
      const second = await start();
      const limited = await start();
      const stateCount = await tempDb.prepare("SELECT COUNT(*) AS count FROM oauth_states").first();

      assert.equal(first.status, 302);
      assert.equal(second.status, 302);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
      assert.match((await limited.json()).error, /too many sign-in attempts/i);
      assert.equal(stateCount.count, 2);
    } finally {
      await tempMf.dispose();
    }
  });

  it("keeps only the ten newest active sessions after sign-in", async () => {
    const authOrigin = "https://auth-session-cap.test";
    let exchangedVerifier = null;
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: authOrigin,
        GITHUB_CLIENT_ID: "fixture-client",
        GITHUB_CLIENT_SECRET: "fixture-secret",
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-session-cap-test" },
      modules: true,
      async outboundService(request) {
        const url = new URL(request.url);
        if (url.pathname === "/login/oauth/access_token") {
          exchangedVerifier = new URLSearchParams(await request.text()).get("code_verifier");
          return Response.json({ access_token: "fixture-access-token" });
        }
        if (url.hostname === "api.github.com" && url.pathname === "/user") {
          return Response.json({
            avatar_url: null,
            id: 424242,
            login: "session-cap-user",
            name: "Session Cap User",
          });
        }
        return new Response("Unexpected outbound request", { status: 500 });
      },
      r2Buckets: { BLOBS: "klippee-session-cap-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const tempDb = await tempMf.getD1Database("DB");
      await applyMigrations(tempDb);
      const timestamp = new Date().toISOString();
      await tempDb.prepare(
        `INSERT INTO users (id, display_name, avatar_url, created_at, updated_at)
         VALUES ('session-cap-user', 'Session Cap User', NULL, ?, ?)`,
      ).bind(timestamp, timestamp).run();
      await tempDb.prepare(
        `INSERT INTO user_identities
           (id, user_id, provider, provider_user_id, provider_username, avatar_url, created_at, updated_at)
         VALUES ('session-cap-identity', 'session-cap-user', 'github', '424242',
                 'session-cap-user', NULL, ?, ?)`,
      ).bind(timestamp, timestamp).run();
      await tempDb.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 12
         )
         INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at)
         SELECT 'session-cap-existing-' || value, 'session-cap-user',
                'session-cap-hash-' || value, '2099-01-01T00:00:00.000Z',
                printf('2026-01-%02dT00:00:00.000Z', value)
         FROM sequence`,
      ).run();
      await tempDb.prepare(
        `INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at)
         VALUES ('session-cap-expired', 'session-cap-user', 'session-cap-expired-hash',
                 '2000-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z')`,
      ).run();
      const start = await tempMf.dispatchFetch(
        new URL("/api/auth/github/start?redirect_to=/printers", authOrigin),
        { redirect: "manual" },
      );
      const authorizationUrl = new URL(start.headers.get("location"));
      const state = authorizationUrl.searchParams.get("state");
      const stateRow = await tempDb.prepare(
        "SELECT pkce_verifier FROM oauth_states WHERE id = ?",
      ).bind(state).first();

      const callback = await tempMf.dispatchFetch(
        new URL(`/api/auth/github/callback?code=fixture-code&state=${state}`, authOrigin),
        {
          headers: { cookie: `__Host-klippee_oauth_state=${state}` },
          redirect: "manual",
        },
      );
      const sessionToken = cookieValue(callback.headers.get("set-cookie") ?? "", "__Host-klippee_session");
      const sessions = await tempDb.prepare(
        `SELECT id FROM sessions
         WHERE user_id = 'session-cap-user'
         ORDER BY created_at DESC, id DESC`,
      ).all();

      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get("location"), `${authOrigin}/printers`);
      assert.equal(exchangedVerifier, stateRow.pkce_verifier);
      assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
      assert.equal(
        authorizationUrl.searchParams.get("code_challenge"),
        base64Url(await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(stateRow.pkce_verifier),
        )),
      );
      assert.equal((callback.headers.get("location") ?? "").includes(stateRow.pkce_verifier), false);
      assert.equal((callback.headers.get("set-cookie") ?? "").includes(stateRow.pkce_verifier), false);
      assert.equal(typeof sessionToken, "string");
      const storedNewSession = await tempDb.prepare(
        "SELECT id FROM sessions WHERE session_hash = ?",
      ).bind(await hashToken(sessionToken)).first();
      assert.equal(sessions.results.length, 10);
      assert.notEqual(storedNewSession, null);
      assert.equal(sessions.results.some((row) => row.id === "session-cap-expired"), false);
      assert.equal(sessions.results.some((row) => row.id === "session-cap-existing-1"), false);
      assert.equal(sessions.results.some((row) => row.id === "session-cap-existing-12"), true);

      const authenticated = await tempMf.dispatchFetch(new URL("/api/auth/me", authOrigin), {
        headers: { cookie: `__Host-klippee_session=${sessionToken}` },
      });
      assert.equal(authenticated.status, 200);
      assert.equal((await authenticated.json()).user.id, "session-cap-user");
    } finally {
      await tempMf.dispose();
    }
  });

  it("rejects invalid PKCE states and consumes a valid Discord state exactly once", async () => {
    const authOrigin = "https://oauth-state-consumption.test";
    const verifierByCode = new Map();
    let exchangedVerifier = null;
    let profileFetches = 0;
    let tokenExchanges = 0;
    const tempMf = new Miniflare({
      compatibilityDate: "2026-05-12",
      bindings: {
        APP_ORIGIN: authOrigin,
        DISCORD_CLIENT_ID: "fixture-client",
        DISCORD_CLIENT_SECRET: "fixture-secret",
        SESSION_SECRET,
      },
      d1Databases: { DB: "klippee-oauth-state-consumption-test" },
      modules: true,
      async outboundService(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/oauth2/token") {
          tokenExchanges += 1;
          const form = new URLSearchParams(await request.text());
          exchangedVerifier = form.get("code_verifier");
          const expectedVerifier = verifierByCode.get(form.get("code"));
          if (expectedVerifier && exchangedVerifier !== expectedVerifier) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return Response.json({ access_token: "fixture-access-token" });
        }
        if (url.hostname === "discord.com" && url.pathname === "/api/users/@me") {
          profileFetches += 1;
          return Response.json({
            avatar: null,
            global_name: "OAuth State User",
            id: "434343",
            username: "oauth-state-user",
          });
        }
        return new Response("Unexpected outbound request", { status: 500 });
      },
      r2Buckets: { BLOBS: "klippee-oauth-state-consumption-blobs" },
      scriptPath: "dist/klippee/index.js",
    });

    try {
      const tempDb = await tempMf.getD1Database("DB");
      await applyMigrations(tempDb);
      const timestamp = new Date().toISOString();
      const rejectedStates = [
        { expiresAt: "2099-01-01T00:00:00.000Z", id: "wrong-provider-state", provider: "github", verifier: "p".repeat(43) },
        { expiresAt: "2000-01-01T00:00:00.000Z", id: "expired-pkce-state", provider: "discord", verifier: "e".repeat(43) },
        { expiresAt: "2099-01-01T00:00:00.000Z", id: "legacy-null-pkce-state", provider: "discord", verifier: null },
      ];
      for (const rejected of rejectedStates) {
        await tempDb.prepare(
          `INSERT INTO oauth_states
           (id, provider, redirect_to, expires_at, created_at, pkce_verifier)
           VALUES (?, ?, '/printers', ?, ?, ?)`,
        ).bind(rejected.id, rejected.provider, rejected.expiresAt, timestamp, rejected.verifier).run();
        const response = await tempMf.dispatchFetch(
          new URL(`/api/auth/discord/callback?code=rejected-code&state=${rejected.id}`, authOrigin),
          {
            headers: { cookie: `__Host-klippee_oauth_state=${rejected.id}` },
            redirect: "manual",
          },
        );
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("location"), `${authOrigin}/?auth=invalid-state`);
        assert.match(response.headers.get("set-cookie") ?? "", /__Host-klippee_oauth_state=;/);
        assert.equal(
          await tempDb.prepare("SELECT id FROM oauth_states WHERE id = ?").bind(rejected.id).first(),
          null,
        );
      }
      assert.equal(tokenExchanges, 0);
      assert.equal(profileFetches, 0);

      const firstFlow = await tempMf.dispatchFetch(
        new URL("/api/auth/discord/start", authOrigin),
        { redirect: "manual" },
      );
      const firstState = new URL(firstFlow.headers.get("location")).searchParams.get("state");
      const firstVerifier = await tempDb.prepare(
        "SELECT pkce_verifier FROM oauth_states WHERE id = ?",
      ).bind(firstState).first();
      const secondFlow = await tempMf.dispatchFetch(
        new URL("/api/auth/discord/start", authOrigin),
        { redirect: "manual" },
      );
      const secondState = new URL(secondFlow.headers.get("location")).searchParams.get("state");
      const secondVerifier = await tempDb.prepare(
        "SELECT pkce_verifier FROM oauth_states WHERE id = ?",
      ).bind(secondState).first();
      verifierByCode.set("code-for-first-flow", firstVerifier.pkce_verifier);

      const substituted = await tempMf.dispatchFetch(
        new URL(`/api/auth/discord/callback?code=code-for-first-flow&state=${secondState}`, authOrigin),
        {
          headers: { cookie: `__Host-klippee_oauth_state=${secondState}` },
          redirect: "manual",
        },
      );
      assert.equal(substituted.status, 302);
      assert.equal(substituted.headers.get("location"), `${authOrigin}/?auth=failed`);
      assert.match(substituted.headers.get("set-cookie") ?? "", /__Host-klippee_oauth_state=;/);
      assert.equal((substituted.headers.get("location") ?? "").includes(secondVerifier.pkce_verifier), false);
      assert.equal((substituted.headers.get("set-cookie") ?? "").includes(secondVerifier.pkce_verifier), false);
      assert.equal(tokenExchanges, 1);
      assert.equal(profileFetches, 0);
      assert.equal((await tempDb.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count, 0);
      await tempDb.prepare("DELETE FROM oauth_states WHERE id = ?").bind(firstState).run();
      verifierByCode.clear();
      exchangedVerifier = null;
      tokenExchanges = 0;

      const start = await tempMf.dispatchFetch(
        new URL("/api/auth/discord/start?redirect_to=/printers", authOrigin),
        { redirect: "manual" },
      );
      const authorizationUrl = new URL(start.headers.get("location"));
      const state = authorizationUrl.searchParams.get("state");
      const stateRow = await tempDb.prepare(
        "SELECT pkce_verifier FROM oauth_states WHERE id = ?",
      ).bind(state).first();

      const callback = () => tempMf.dispatchFetch(
        new URL(`/api/auth/discord/callback?code=fixture-code&state=${state}`, authOrigin),
        {
          headers: { cookie: `__Host-klippee_oauth_state=${state}` },
          redirect: "manual",
        },
      );
      const responses = await Promise.all(Array.from({ length: 8 }, callback));
      const locations = responses.map((response) => response.headers.get("location"));
      const sessions = await tempDb.prepare("SELECT COUNT(*) AS count FROM sessions").first();
      const remainingState = await tempDb.prepare(
        "SELECT id FROM oauth_states WHERE id = ?",
      ).bind(state).first();

      assert.equal(responses.every((response) => response.status === 302), true);
      assert.equal(locations.filter((location) => location === `${authOrigin}/printers`).length, 1);
      assert.equal(locations.filter((location) => location === `${authOrigin}/?auth=invalid-state`).length, 7);
      assert.equal(
        responses.every((response) => (
          !(response.headers.get("location") ?? "").includes(stateRow.pkce_verifier)
          && !(response.headers.get("set-cookie") ?? "").includes(stateRow.pkce_verifier)
        )),
        true,
      );
      assert.equal(tokenExchanges, 1);
      assert.equal(profileFetches, 1);
      assert.equal(exchangedVerifier, stateRow.pkce_verifier);
      assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
      assert.equal(
        authorizationUrl.searchParams.get("code_challenge"),
        base64Url(await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(stateRow.pkce_verifier),
        )),
      );
      assert.equal(sessions.count, 1);
      assert.equal(remainingState, null);
    } finally {
      await tempMf.dispose();
    }
  });

  it("rejects state-changing browser requests without a trusted origin before DB writes", async () => {
    const response = await dispatch("/api/repos", {
      body: JSON.stringify({ name: "Blocked" }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(body, { error: "Untrusted request origin" });
  });
});
