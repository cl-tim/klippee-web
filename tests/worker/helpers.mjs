import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "./miniflare.mjs";

export const WORKER_ORIGIN = "https://klippee.test";
export const SESSION_SECRET = "worker-smoke-secret";
export const SESSION_TOKEN = "session_token";
export const SECOND_SESSION_TOKEN = "second_session_token";
export const REVIEW_TOKEN = "review_token_for_worker_smoke_tests";
export const STORAGE_MAINTENANCE_TOKEN = "storage_maintenance_token_for_worker_smoke_tests";
export const STORAGE_LIMITS = {
  canonicalBlobBytesPerUser: 512 * 1_024 * 1_024,
  canonicalBlobBytesTotal: 20 * 1_024 * 1_024 * 1_024,
  companionAssets: 64,
  printerIdBytes: 128,
  printerNameBytes: 256,
  printers: 32,
  privatePackages: 64,
  repositories: 32,
  repositoryVersions: 256,
  syncTokens: 16,
};
export const STORAGE_RESOURCES = {
  companionAssets: {
    action: "Edit an existing preset or delete an unused one in Orca Workspace > Open preset editor.",
    id: "companion-assets",
    label: "companion assets",
  },
  printers: {
    action: "Remove an existing printer before creating another.",
    id: "printers",
    label: "printers",
  },
  privatePackages: {
    action: "Edit an existing package or delete an unused one under Shared Configs > Private packages.",
    id: "private-packages",
    label: "private packages",
  },
  repositories: {
    action: "Reuse an existing configuration or delete an unused one under Printers > Saved configurations.",
    id: "repositories",
    label: "configuration repositories",
  },
  repositoryVersions: {
    action: "Remove an unneeded version before creating another.",
    id: "repository-versions",
    label: "retained repository versions",
  },
  syncTokens: {
    action: "Revoke an existing sync token before creating another.",
    id: "sync-tokens",
    label: "sync tokens for this repository",
  },
};
export const MIGRATION_FILES = [
  "0001_initial_schema.sql",
  "0002_auth_schema.sql",
  "0003_user_app_state.sql",
  "0004_repositories.sql",
  "0005_sync_tokens.sql",
  "0006_private_packages.sql",
  "0007_public_packages.sql",
  "0008_printers.sql",
  "0009_sync_token_printers.sql",
  "0010_public_package_search.sql",
  "0011_public_package_search_indexes.sql",
  "0012_companion_assets.sql",
  "0013_printer_host_info.sql",
  "0014_diagnostic_uploads.sql",
  "0015_log_improvement_submissions.sql",
  "0016_public_package_repositories.sql",
  "0017_orca_preset_kinds.sql",
  "0018_repository_pending_config.sql",
  "0019_applied_state_metadata.sql",
  "0020_public_package_approval.sql",
  "0021_canonical_blob_budgets.sql",
  "0022_canonical_blob_reclamation.sql",
  "0023_oauth_pkce.sql",
  "0024_orca_setups.sql",
  "0025_orca_profile_library.sql",
  "0026_orca_devices.sql",
  "0027_orca_device_uploads.sql",
  "0028_public_package_auto_updates.sql",
  "0029_orca_publication_updates.sql",
  "0030_repository_history_reference_index.sql",
];
const __dirname = dirname(fileURLToPath(import.meta.url));

export let mf;
export let db;
export let reclaimHookState = null;
export let publicListingPatchHookState = null;

export function armReclaimHook(hash) {
  let release;
  let reached;
  let secondQueued;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  const secondQueuedPromise = new Promise((resolve) => { secondQueued = resolve; });
  reclaimHookState = {
    afterHeadCalls: 0,
    hash,
    queuedCalls: 0,
    reached,
    releasePromise,
    secondQueued,
  };
  return {
    queued: secondQueuedPromise,
    reached: reachedPromise,
    release: () => release(),
  };
}

export function armPublicListingPatchHook() {
  let release;
  let reached;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  publicListingPatchHookState = { reached, releasePromise };
  return {
    reached: reachedPromise,
    release: () => release(),
  };
}

export async function dispatch(path, init) {
  return mf.dispatchFetch(new URL(path, WORKER_ORIGIN), init);
}

export function base64Url(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashToken(token) {
  const encoded = new TextEncoder().encode(`${SESSION_SECRET}:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64Url(digest);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cookieValue(setCookie, name) {
  const match = setCookie.match(new RegExp(`${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function assertStorageQuota(body, resource, limit) {
  assert.deepEqual(body, {
    code: "storage_quota_exceeded",
    error: `Storage limit reached for ${resource.label}. ${resource.action}`,
    limit,
    resource: resource.id,
  });
}

export async function assertUploadRateLimit(response, resource, error) {
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), {
    code: "upload_rate_limit_exceeded",
    error,
    resource,
    retryAfterSeconds: 60,
  });
}

export async function enterStableRateLimitWindow(periodSeconds, minimumRemainingMs = 3_000) {
  const periodMs = periodSeconds * 1_000;
  const remainingMs = periodMs - (Date.now() % periodMs);
  if (remainingMs < minimumRemainingMs) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs + 150));
  }
}

export async function waitForNextRateLimitWindow(periodSeconds) {
  const periodMs = periodSeconds * 1_000;
  const remainingMs = periodMs - (Date.now() % periodMs);
  await new Promise((resolve) => setTimeout(resolve, remainingMs + 150));
}

export function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    current += character;
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) {
          current += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== ";") continue;

    const trimmed = current.trim();
    const isTrigger = /^CREATE\s+TRIGGER\b/i.test(trimmed);
    const finalLine = trimmed.split(/\r?\n/).at(-1)?.trim();
    if (isTrigger && !/^END\s*;$/i.test(finalLine ?? "")) {
      continue;
    }
    if (trimmed !== ";") {
      statements.push(trimmed.slice(0, -1));
    }
    current = "";
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export async function applyMigration(targetDb, file) {
  await targetDb.prepare(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE,
       applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
     )`,
  ).run();
  const sql = (await readFile(join(__dirname, "..", "..", "migrations", file), "utf8"))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  if (sql.trim()) {
    for (const statement of splitSqlStatements(sql)) {
      await targetDb.prepare(statement).run();
    }
  }
  // Wrangler records one row per file. Conflict tolerance lets the dedicated
  // migration-idempotency tests replay SQL without inventing a second ledger row.
  await targetDb.prepare(
    "INSERT INTO d1_migrations (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
  ).bind(file).run();
}

export async function applyMigrations(targetDb = db, through = MIGRATION_FILES.at(-1)) {
  for (const file of MIGRATION_FILES) {
    await applyMigration(targetDb, file);
    if (file === through) break;
  }
}

export async function seedSyncFixtures() {
  const now = new Date().toISOString();
  const packageJson = JSON.stringify({
    description: "A stored private package fixture.",
    files: [
      {
        content: "[include macros.cfg]\n",
        path: "printer.cfg",
        public: false,
        role: "entrypoint",
      },
      {
        content: "[gcode_macro TEST]\ngcode: M117 ok\n",
        path: "macros.cfg",
        public: false,
        role: "macro",
      },
    ],
    hardware: ["cartesian"],
    id: "package_1",
    name: "stored-package",
    printer: "Bench printer",
    tags: ["private", "fixture"],
    title: "Stored package",
    variables: [
      {
        description: "Optional secret used to verify artifact storage skips secret-bearing renders.",
        label: "Wi-Fi password",
        name: "wifi_password",
        required: false,
        secret: true,
        type: "text",
      },
    ],
    version: "2026.05.18",
    warnings: ["Fixture warning"],
  });
  const filesJson = JSON.stringify([
    {
      content: "[printer]\nkinematics: cartesian\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    },
  ]);

  await db.prepare(
    `INSERT INTO users (id, display_name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind("user_1", "Test User", null, now, now)
    .run();

  await db.prepare(
    `INSERT INTO users (id, display_name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind("user_2", "Other User", null, now, now)
    .run();

  await db.prepare(
    `INSERT INTO user_identities
     (id, user_id, provider, provider_user_id, provider_username, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("identity_1", "user_1", "github", "github_user_1", "test-user", null, now, now)
    .run();

  await db.prepare(
    `INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind("session_1", "user_1", await hashToken(SESSION_TOKEN), "2099-01-01T00:00:00.000Z", now)
    .run();

  await db.prepare(
    `INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind("session_2", "user_2", await hashToken(SECOND_SESSION_TOKEN), "2099-01-01T00:00:00.000Z", now)
    .run();

  await db.prepare(
    `INSERT INTO repositories (id, user_id, name, title, latest_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("repo_1", "user_1", "test-printer", "Test printer", "version_1", now, now)
    .run();

  await db.prepare(
    `INSERT INTO repositories (id, user_id, name, title, latest_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("repo_other", "user_2", "other-printer", "Other printer", null, now, now)
    .run();

  await db.prepare(
    `INSERT INTO repository_versions
     (id, repository_id, version_number, previous_version_id, message, source, files_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("version_1", "repo_1", 1, null, "Initial version", "web-editor", filesJson, now)
    .run();

  await db.prepare(
    `INSERT INTO printers
     (id, user_id, name, description, make, model, source, definition_json, package_ids_json, variable_values_json,
      repository_id, latest_version_id, applied_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "printer_1",
      "user_1",
      "Bench printer",
      "",
      "",
      "",
      "manual",
      "{}",
      "[]",
      "{}",
      "repo_1",
      1,
      0,
      now,
      now,
    )
    .run();

  await db.prepare(
    `INSERT INTO sync_tokens
     (id, user_id, repository_id, printer_id, name, token_hash, token_prefix, scopes_json, last_used_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "sync_token_printer",
      "user_1",
      "repo_1",
      "printer_1",
      "Printer token",
      await hashToken("klp_printer_token"),
      "klp_printer",
      JSON.stringify(["repo:read", "repo:write"]),
      null,
      null,
      now,
    )
    .run();

  await db.prepare(
    `INSERT INTO sync_tokens
     (id, user_id, repository_id, printer_id, name, token_hash, token_prefix, scopes_json, last_used_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "sync_token_repo",
      "user_1",
      "repo_1",
      null,
      "Repository token",
      await hashToken("klp_repo_token"),
      "klp_repo_tok",
      JSON.stringify(["repo:read", "repo:write"]),
      null,
      null,
      now,
    )
    .run();

  await db.prepare(
    `INSERT INTO private_packages
     (id, user_id, package_id, name, title, package_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("private_package_1", "user_1", "package_1", "stored-package", "Stored package", packageJson, now, now)
    .run();
}

export async function seedUploadRateLimitFixtures(targetDb) {
  const now = new Date().toISOString();
  const fixtures = {
    printerTokenA: "klp_rate_printer_a",
    printerTokenB: "klp_rate_printer_b",
    printerTokenC: "klp_rate_printer_c",
    sessionA: "rate_session_a",
    sessionA2: "rate_session_a_2",
    sessionB: "rate_session_b",
  };
  const [sessionHashA, sessionHashA2, sessionHashB, tokenHashA, tokenHashB, tokenHashC] = await Promise.all([
    hashToken(fixtures.sessionA),
    hashToken(fixtures.sessionA2),
    hashToken(fixtures.sessionB),
    hashToken(fixtures.printerTokenA),
    hashToken(fixtures.printerTokenB),
    hashToken(fixtures.printerTokenC),
  ]);

  await targetDb.batch([
    targetDb.prepare(
      `INSERT INTO users (id, display_name, avatar_url, created_at, updated_at)
       VALUES ('rate_user_a', 'Rate user A', NULL, ?, ?),
              ('rate_user_b', 'Rate user B', NULL, ?, ?)`,
    ).bind(now, now, now, now),
    targetDb.prepare(
      `INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at)
       VALUES ('rate_session_a', 'rate_user_a', ?, '2099-01-01T00:00:00.000Z', ?),
              ('rate_session_a_2', 'rate_user_a', ?, '2099-01-01T00:00:00.000Z', ?),
              ('rate_session_b', 'rate_user_b', ?, '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(sessionHashA, now, sessionHashA2, now, sessionHashB, now),
    targetDb.prepare(
      `INSERT INTO repositories (id, user_id, name, title, latest_version_id, created_at, updated_at)
       VALUES ('rate_repo', 'rate_user_a', 'rate-repo', 'Rate-limit fixtures', NULL, ?, ?)`,
    ).bind(now, now),
    targetDb.prepare(
      `INSERT INTO printers
       (id, user_id, name, description, make, model, source, definition_json, package_ids_json,
        variable_values_json, repository_id, latest_version_id, applied_version_id, created_at, updated_at)
       VALUES ('rate_printer_a', 'rate_user_a', 'Rate printer A', '', '', '', 'manual', '{}', '[]', '{}',
               'rate_repo', 0, 0, ?, ?),
              ('rate_printer_b', 'rate_user_a', 'Rate printer B', '', '', '', 'manual', '{}', '[]', '{}',
               'rate_repo', 0, 0, ?, ?)`,
    ).bind(now, now, now, now),
    targetDb.prepare(
      `INSERT INTO sync_tokens
       (id, user_id, repository_id, printer_id, name, token_hash, token_prefix, scopes_json,
        last_used_at, expires_at, created_at)
       VALUES ('rate_token_a', 'rate_user_a', 'rate_repo', 'rate_printer_a', 'Rate token A', ?,
               'klp_rate_a', '["repo:write"]', NULL, NULL, ?),
              ('rate_token_b', 'rate_user_a', 'rate_repo', 'rate_printer_a', 'Rate token B', ?,
               'klp_rate_b', '["repo:write"]', NULL, NULL, ?),
              ('rate_token_c', 'rate_user_a', 'rate_repo', 'rate_printer_b', 'Rate token C', ?,
               'klp_rate_c', '["repo:write"]', NULL, NULL, ?)`,
    ).bind(tokenHashA, now, tokenHashB, now, tokenHashC, now),
  ]);

  return fixtures;
}

export async function publishStoredPackage() {
  const response = await dispatch("/api/public-packages", {
    body: JSON.stringify({
      package: {
        id: "package_1",
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

  assert.equal(response.status, 201);
  return body;
}

export async function insertPrivatePackage(
  packageId,
  files,
  warnings = [],
  variables = [],
  companionAssetIds = [],
  userId = "user_1",
) {
  const now = new Date().toISOString();
  const packageJson = JSON.stringify({
    companionAssetIds,
    description: `Fixture for ${packageId}.`,
    files,
    hardware: ["cartesian"],
    id: packageId,
    name: packageId,
    printer: "Bench printer",
    tags: ["private", "fixture"],
    title: packageId,
    variables,
    version: "2026.05.19",
    warnings,
  });

  await db.prepare(
    `INSERT INTO private_packages
     (id, user_id, package_id, name, title, package_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, package_id) DO UPDATE SET
       package_json = excluded.package_json,
       updated_at = excluded.updated_at`,
  )
    .bind(crypto.randomUUID(), userId, packageId, packageId, packageId, packageJson, now, now)
    .run();
}

export async function createCompanionAsset(kind = "machine") {
  const response = await dispatch("/api/companion-assets", {
    body: JSON.stringify({
      asset: {
        content: kind === "machine"
          ? '{"type":"machine","name":"fixture","nozzle_diameter":["0.4"]}'
          : '{"type":"filament","name":"fixture","nozzle_temperature":["210"]}',
        description: `${kind} fixture`,
        kind,
        tags: [kind, "fixture"],
        title: `${kind} fixture`,
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
  assert.equal(response.status, 201);
  return body.asset;
}

export function createWorkerMiniflare(overrides = {}) {
  return new Miniflare({
    compatibilityDate: "2026-05-12",
    bindings: {
      APP_ORIGIN: WORKER_ORIGIN,
      LOCAL_AUTH_BYPASS: "1",
      LOG_IMPROVEMENT_REVIEW_TOKEN: REVIEW_TOKEN,
      SESSION_SECRET,
      STORAGE_MAINTENANCE_TOKEN,
    },
    d1Databases: { DB: "klippee-test" },
    durableObjects: {
      CANONICAL_BLOB_RECLAIMER: {
        className: "CanonicalBlobReclaimer",
        useSQLite: true,
      },
    },
    modules: true,
    ratelimits: {
      DIAGNOSTIC_UPLOAD_RATE_LIMITER: {
        namespace_id: "test-main-diagnostic-uploads",
        simple: { limit: 1_000, period: 60 },
      },
      LOG_IMPROVEMENT_RATE_LIMITER: {
        namespace_id: "test-main-log-improvements",
        simple: { limit: 1_000, period: 60 },
      },
    },
    r2Buckets: { BLOBS: "klippee-test-blobs" },
    serviceBindings: {
      STORAGE_RECLAIM_TEST_HOOK: async (request) => {
        const parts = new URL(request.url).pathname.split("/");
        const hash = decodeURIComponent(parts.at(-1) ?? "");
        const stage = parts.at(-2);
        if (!reclaimHookState || reclaimHookState.hash !== hash) {
          return new Response(null, { status: 204 });
        }
        if (stage === "queued") {
          reclaimHookState.queuedCalls += 1;
          if (reclaimHookState.queuedCalls >= 2) reclaimHookState.secondQueued();
          return new Response(null, { status: 204 });
        }
        reclaimHookState.afterHeadCalls += 1;
        reclaimHookState.reached();
        await reclaimHookState.releasePromise;
        return new Response(null, { status: 204 });
      },
      PUBLIC_LISTING_PATCH_TEST_HOOK: async () => {
        if (!publicListingPatchHookState) return new Response(null, { status: 204 });
        publicListingPatchHookState.reached();
        await publicListingPatchHookState.releasePromise;
        return new Response(null, { status: 204 });
      },
    },
    scriptPath: "dist/klippee/index.js",
    // Allows the cron cleanup test to invoke scheduled() via Miniflare's local trigger route.
    unsafeTriggerHandlers: true,
    ...overrides,
  });
}

// Replicates the original shared `before()` of tests/worker-api-smoke.mjs.
export async function bootSharedWorker() {
  mf = createWorkerMiniflare();
  db = await mf.getD1Database("DB");
  await applyMigrations();
  await seedSyncFixtures();
  return { mf, db };
}

export async function disposeSharedWorker() {
  await mf?.dispose();
  mf = undefined;
  db = undefined;
  reclaimHookState = null;
  publicListingPatchHookState = null;
}

export function clearReclaimHook() {
  reclaimHookState = null;
}
