import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import { readConfig, startSelfHost } from "../../scripts/self-host.mjs";
import { requestLocalApp } from "../../scripts/self-host-smoke-http.mjs";

const environment = {
  APP_ORIGIN: "https://klippee.example.com",
  SESSION_SECRET: "test-only-secret-0123456789abcdef0123456789abcdef",
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-only-client-secret",
  HOST: "127.0.0.1",
  PORT: "0",
};

test("self-hosting validates auth mode and requires OAuth credentials only in OAuth mode", () => {
  for (const patch of [{ APP_ORIGIN: "http://localhost" }, { SESSION_SECRET: "short" }, { GITHUB_CLIENT_SECRET: "" }, { APP_ORIGIN: "https://example.com/path" }, { AUTH_MODE: "off" }]) {
    assert.throws(() => readConfig({ ...environment, ...patch }));
  }
  const config = readConfig({ ...environment, LOCAL_AUTH_BYPASS: "1" });
  assert.equal(config.bindings.LOCAL_AUTH_BYPASS, "0");
  assert.equal(config.origin, environment.APP_ORIGIN);
  assert.equal(config.authMode, "oauth");
  assert.equal(readConfig({ ...environment, AUTH_MODE: "local", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" }).authMode, "local");
  assert.throws(() => readConfig({ ...environment, AUTH_MODE: "local", SESSION_SECRET: "" }));
});

test("standalone release serves the app, authenticates, migrates and persists across restart", { timeout: 120_000 }, async () => {
  await mkdir(resolve("output"), { recursive: true });
  const directory = await mkdtemp(resolve("output/self-host-test-"));
  const config = readConfig({ ...environment, KLIPPEE_DATA_DIR: directory });
  let app;
  try {
    app = await startSelfHost(config);
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    const get = (path, options) => fetch(`${baseUrl}${path}`, { redirect: "manual", ...options });
    const health = await get("/api/health");
    assert.equal(health.status, 200, await health.clone().text());
    assert.equal((await health.json()).ok, true);
    const html = await get("/printers");
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<div id="root">/);
    assert.match(html.headers.get("content-security-policy"), /nonce-/);
    assert.equal(html.headers.get("cache-control"), "no-store");
    assert.equal((await (await get("/api/auth/me", { headers: { host: "localhost" } })).json()).user, null);
    for (const path of ["/cdn-cgi/local/scheduled", "/__inspect", "/cdn-cgi/explorer"]) {
      assert.equal((await get(path)).status, 404);
    }
    const oauth = await get("/api/auth/github/start");
    assert.equal(oauth.status, 302);
    const authorize = new URL(oauth.headers.get("location"));
    assert.equal(authorize.searchParams.get("redirect_uri"), `${config.origin}/api/auth/github/callback`);
    assert.match(oauth.headers.get("set-cookie"), /Secure/);
    const db = await app.runtime.getD1Database("DB");
    const before = (await db.prepare("SELECT COUNT(*) AS count FROM d1_migrations").first()).count;
    assert.ok(before >= 30);
    await db.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind("self-host-test-user", "Example User", "2026-11-22", "2026-11-22").run();
    const token = "self-host-test-session";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${environment.SESSION_SECRET}:${token}`));
    const hash = Buffer.from(digest).toString("base64url");
    await db.prepare("INSERT INTO sessions (id, session_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind("test-session", hash, "self-host-test-user", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()).run();
    const me = await get("/api/auth/me", { headers: { cookie: `__Host-klippee_session=${token}` } });
    assert.equal((await me.json()).user.id, "self-host-test-user");
    const bucket = await app.runtime.getR2Bucket("BLOBS");
    await bucket.put("self-host-test/snapshot", "example configuration");
    await app.close();
    app = undefined;
    app = await startSelfHost(config);
    const restartedDb = await app.runtime.getD1Database("DB");
    assert.equal((await restartedDb.prepare("SELECT COUNT(*) AS count FROM d1_migrations").first()).count, before);
    assert.equal((await restartedDb.prepare("SELECT display_name FROM users WHERE id = ?").bind("self-host-test-user").first()).display_name, "Example User");
    assert.equal(await (await (await app.runtime.getR2Bucket("BLOBS")).get("self-host-test/snapshot")).text(), "example configuration");

    await app.close();
    app = undefined;
    const local = readConfig({ ...environment, KLIPPEE_DATA_DIR: directory, AUTH_MODE: "local", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" });
    app = await startSelfHost(local);
    const localRequest = (path, options = {}) => requestLocalApp(app.server.address().port, path, {
      ...options,
      headers: { host: local.originHost, ...options.headers },
    });
    const workspace = await localRequest("/api/auth/me", { headers: { cookie: `__Host-klippee_session=${token}` } });
    assert.equal(workspace.status, 200);
    assert.equal(workspace.headers.get("set-cookie"), null);
    const { user } = await workspace.json();
    assert.equal(user.mode, "local");
    assert.notEqual(user.id, "self-host-test-user");
    assert.deepEqual(user.providers, []);
    assert.equal((await localRequest("/api/auth/me", { headers: { host: "untrusted.example.com", "x-forwarded-host": local.originHost } })).status, 421);
    for (const path of ["/api/auth/github/start", "/api/auth/discord/callback"]) {
      assert.equal((await localRequest(path)).status, 404);
    }
    const repo = { empty: true, name: "example", title: "Example printer" };
    const post = (path, body, origin) => localRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
    assert.equal((await post("/api/repos", repo, "https://untrusted.example.com")).status, 403);
    const created = await post("/api/repos", repo, local.origin);
    assert.equal(created.status, 201, await created.clone().text());
    const { repository } = await created.json();
    const issued = await post(`/api/repos/${repository.id}/sync-tokens`, { scopes: ["repo:read"] }, local.origin);
    assert.equal(issued.status, 201, await issued.clone().text());
    const { token: syncToken } = await issued.json();
    const syncPath = `/api/sync/repos/${repository.id}/status.txt`;
    assert.equal((await localRequest(syncPath)).status, 401);
    assert.equal((await localRequest(syncPath, { headers: { authorization: `Bearer ${syncToken}` } })).status, 200);
  } finally {
    await app?.close();
    assert.ok(directory.startsWith(resolve("output") + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
