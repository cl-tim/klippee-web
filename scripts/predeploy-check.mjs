import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { deploymentOrigin } from "./deployment-origin.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

const requiredBindings = {
  assets: "ASSETS",
  d1: "DB",
  cadDurableObject: "CAD_CONTAINER",
  canonicalBlobReclaimer: "CANONICAL_BLOB_RECLAIMER",
  r2: "BLOBS",
};

const requiredUploadRateLimits = [
  {
    limit: 4,
    name: "DIAGNOSTIC_UPLOAD_RATE_LIMITER",
    period: 60,
  },
  {
    limit: 24,
    name: "LOG_IMPROVEMENT_RATE_LIMITER",
    period: 60,
  },
];

function fail(message) {
  throw new Error(message);
}

async function assertMigrations() {
  const files = (await readdir("migrations"))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();

  if (files.length === 0) {
    fail("No D1 migration files found in migrations/");
  }

  files.forEach((file, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (!file.startsWith(`${expected}_`)) {
      fail(`D1 migration sequence has a gap or ordering issue at ${file}; expected prefix ${expected}_`);
    }
  });

  for (const file of files) {
    const sql = await readFile(join("migrations", file), "utf8");
    if (!sql.trim()) {
      fail(`D1 migration ${file} is empty`);
    }
  }

  return files;
}

async function assertHealthMigrationMarker(latestMigration) {
  const healthSource = await readFile("worker/routes/health.ts", "utf8");
  const marker = healthSource.match(
    /export const requiredD1Migration = ["']([^"']+)["']/,
  )?.[1];
  if (marker !== latestMigration) {
    fail(
      `Worker health must require the newest D1 migration ${latestMigration}; found ${marker ?? "no marker"}`,
    );
  }
}

function assertWranglerBindings(config) {
  if (config.assets?.binding !== requiredBindings.assets) {
    fail(`wrangler.jsonc must bind assets as ${requiredBindings.assets}`);
  }

  // The @cloudflare/vite-plugin writes client assets to dist/client and the
  // Worker bundle to dist/klippee. The committed config must point at the
  // client directory only, so a bare `wrangler deploy` (without the
  // .wrangler/deploy/config.json redirect) can never upload the compiled
  // Worker bundle as a public static asset.
  if (config.assets?.directory !== "./dist/client") {
    fail("wrangler.jsonc assets.directory must be ./dist/client (the vite-plugin client output)");
  }

  if (!config.vars?.APP_ORIGIN || !String(config.vars.APP_ORIGIN).startsWith("https://")) {
    fail("wrangler.jsonc must set production APP_ORIGIN to an https URL");
  }

  const d1 = config.d1_databases?.find((binding) => binding.binding === requiredBindings.d1);
  if (!d1?.database_name || !d1?.database_id) {
    fail(`wrangler.jsonc must include D1 binding ${requiredBindings.d1} with database_name and database_id`);
  }
  if (d1.migrations_table && d1.migrations_table !== "d1_migrations") {
    fail("Worker health requires the default D1 migration ledger table d1_migrations");
  }

  const r2 = config.r2_buckets?.find((binding) => binding.binding === requiredBindings.r2);
  if (!r2?.bucket_name) {
    fail(`wrangler.jsonc must include R2 binding ${requiredBindings.r2} with bucket_name`);
  }

  const cadDurableObject = config.durable_objects?.bindings?.find(
    (binding) => binding.name === requiredBindings.cadDurableObject,
  );
  if (!cadDurableObject?.class_name) {
    fail(`wrangler.jsonc must include Durable Object binding ${requiredBindings.cadDurableObject}`);
  }

  const canonicalBlobReclaimer = config.durable_objects?.bindings?.find(
    (binding) => binding.name === requiredBindings.canonicalBlobReclaimer,
  );
  if (canonicalBlobReclaimer?.class_name !== "CanonicalBlobReclaimer") {
    fail(`wrangler.jsonc must include Durable Object binding ${requiredBindings.canonicalBlobReclaimer}`);
  }
  if (!config.migrations?.some(
    (migration) => migration.new_sqlite_classes?.includes(canonicalBlobReclaimer.class_name),
  )) {
    fail("wrangler.jsonc must migrate the canonical blob reclaimer as a SQLite Durable Object");
  }

  const cadContainer = config.containers?.find((container) => container.class_name === cadDurableObject.class_name);
  if (cadContainer?.image !== "./Dockerfile.cad") {
    fail("wrangler.jsonc must deploy the dedicated CAD container image");
  }

  const cadRateLimit = config.ratelimits?.find((binding) => binding.name === "CAD_RATE_LIMITER");
  if (!cadRateLimit) {
    fail("wrangler.jsonc must rate-limit public CAD processing");
  }
  if (cadRateLimit.simple?.period !== 60 || cadRateLimit.simple?.limit < 20) {
    fail("wrangler.jsonc must allow at least 20 CAD requests per minute");
  }

  const rateLimits = config.ratelimits ?? [];
  const rateLimitNames = rateLimits.map((binding) => binding.name);
  if (new Set(rateLimitNames).size !== rateLimitNames.length) {
    fail("wrangler.jsonc rate-limit binding names must be unique");
  }

  const namespaceIds = rateLimits.map((binding) => binding.namespace_id);
  if (namespaceIds.some(
    (namespaceId) => typeof namespaceId !== "string" || !/^[1-9]\d*$/.test(namespaceId),
  )) {
    fail("wrangler.jsonc rate-limit namespace IDs must be positive integer strings");
  }
  if (new Set(namespaceIds).size !== namespaceIds.length) {
    fail("wrangler.jsonc rate-limit namespace IDs must be unique");
  }

  for (const required of requiredUploadRateLimits) {
    const binding = rateLimits.find((candidate) => candidate.name === required.name);
    if (
      binding?.simple?.limit !== required.limit
      || binding.simple?.period !== required.period
    ) {
      fail(
        `wrangler.jsonc must configure ${required.name} `
        + `with ${required.limit} requests per ${required.period} seconds`,
      );
    }
  }

  if (!Array.isArray(config.containers) || config.containers.length !== 1) {
    fail("wrangler.jsonc must deploy only the dedicated CAD container");
  }

  if (config.durable_objects?.bindings?.some((binding) => binding.name === "STL_CONTAINER")) {
    fail("wrangler.jsonc must not retain the removed STL container binding");
  }

  if (!config.migrations?.some((migration) => migration.deleted_classes?.includes("StlGeometryContainer"))) {
    fail("wrangler.jsonc must include the Durable Object migration that retires StlGeometryContainer");
  }
}

async function assertCloudflareDeploymentDocs() {
  const [deployment, readiness] = await Promise.all([
    readFile("docs/operations/deployment.md", "utf8"),
    readFile("docs/operations/production-readiness.md", "utf8"),
  ]);
  const combined = `${deployment}\n${readiness}`;
  const requiredSnippets = [
    "Cloudflare Workers Builds",
    "Production branch: your deployment branch",
    "`npm run build`",
    "`npm run deploy`",
    // The documented deploy command must run migrations before updating the Worker.
    "Deploy command: npm run deploy",
    "npm run check",
    "npm run predeploy",
    "npx wrangler d1 migrations apply DB --remote",
    "npm run smoke:prod",
    "npm run launch:verify",
    "CAD_CONTAINER",
    "CANONICAL_BLOB_RECLAIMER",
    "DIAGNOSTIC_UPLOAD_RATE_LIMITER",
    "LOG_IMPROVEMENT_RATE_LIMITER",
  ];

  for (const snippet of requiredSnippets) {
    if (!combined.includes(snippet)) {
      fail(`Cloudflare deployment docs are missing required guidance: ${snippet}`);
    }
  }
}

// Guards the deploy path itself: Cloudflare Workers Builds runs `npm run deploy`,
// so that script must apply remote D1 migrations *before* invoking Wrangler.
// Without this, a Worker can deploy against a schema that was never migrated and
// fail at runtime.
async function assertDeployAppliesMigrations() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const scripts = pkg.scripts ?? {};

  const migrate = scripts["db:migrate"] ?? "";
  if (!migrate.includes("wrangler d1 migrations apply DB --remote")) {
    fail("package.json 'db:migrate' must run 'wrangler d1 migrations apply DB --remote'");
  }

  const deploy = scripts.deploy ?? "";
  const migrateIndex = deploy.search(/db:migrate|wrangler d1 migrations apply/);
  const deployIndex = deploy.search(/wrangler deploy/);

  if (migrateIndex === -1) {
    fail("package.json 'deploy' script must apply D1 migrations (db:migrate) before deploying the Worker");
  }
  if (deployIndex === -1) {
    fail("package.json 'deploy' script must run 'wrangler deploy'");
  }
  if (migrateIndex > deployIndex) {
    fail("package.json 'deploy' script must apply D1 migrations BEFORE 'wrangler deploy', not after");
  }
}

async function assertCadIsStateless() {
  const [proxy, service, dockerfile] = await Promise.all([
    readFile("worker/routes/cad.ts", "utf8"),
    readFile("server/cad_app.py", "utf8"),
    readFile("Dockerfile.cad", "utf8"),
  ]);
  for (const forbidden of ["env.BLOBS", "env.DB"]) {
    if (proxy.includes(forbidden)) {
      fail(`CAD proxy must not access configuration storage through ${forbidden}`);
    }
  }
  if (!service.includes('"storage": "none"') || !service.includes("TemporaryDirectory")) {
    fail("CAD service must report no storage and process requests in temporary directories");
  }
  if (
    !service.includes('BUNDLED_SCAD_LIBRARY_ROOTS = frozenset({"BOSL2"})')
    || !dockerfile.includes("OPENSCAD_VERSION=2026.04.05")
    || !dockerfile.includes("OpenSCAD-${OPENSCAD_VERSION}-x86_64.AppImage")
    || !dockerfile.includes("gridfinity-bin.stl")
    || !dockerfile.includes("gridfinity-lite-bin.stl")
    || !dockerfile.includes("gridfinity-baseplate.stl")
    || !dockerfile.includes("openGrid.stl")
    || !dockerfile.includes("BOSL2_VERSION=v2.0.747")
    || !dockerfile.includes("OPENSCADPATH=/opt/openscad/libraries")
    || !dockerfile.includes("sha256sum --check --strict")
    || !dockerfile.includes("bosl2-smoke.stl")
  ) {
    fail("CAD container must install pinned OpenSCAD and BOSL2 runtimes and smoke-test bundled Gridfinity and openGrid models");
  }
}

const CLI_SOURCE_PATH = "public/install/klippee.py";
const CLI_VERSION_PATTERN = /^CLI_VERSION\s*=\s*["']([^"']+)["']\s*$/m;
const CLI_VERSION_FORMAT = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?$/;

// Mirrors cli_version_key in public/install/klippee.py: CLI versions are
// YYYY.MM.DD[.N] compared as integer tuples, where a missing .N sorts below
// any explicit .N (Python tuple ordering).
function cliVersionKey(value) {
  if (!CLI_VERSION_FORMAT.test(value)) {
    fail(`invalid Klippee CLI version: ${value}`);
  }
  return value.split(".").map(Number);
}

function cliVersionCompare(a, b) {
  const keyA = cliVersionKey(a);
  const keyB = cliVersionKey(b);
  const length = Math.max(keyA.length, keyB.length);
  for (let index = 0; index < length; index += 1) {
    const partA = keyA[index];
    const partB = keyB[index];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    if (partA !== partB) return partA < partB ? -1 : 1;
  }
  return 0;
}

// Guards CLI upgrades: printers refuse to replace their installed CLI unless
// the downloaded CLI_VERSION is strictly greater (see cli_version_key /
// upgrade flow in public/install/klippee.py). Shipping changed CLI bytes
// without a version bump would therefore deploy a CLI that installed printers
// silently never pick up. Design choice: a network failure fetching the
// deployed CLI is a WARNING, not a failure, so `npm run predeploy` still
// works offline; Cloudflare Workers Builds and CI both have network access,
// so the guard is effective on the paths that actually deploy.
async function assertCliVersionBumped(configuredOrigin) {
  const localBytes = await readFile(CLI_SOURCE_PATH);
  const localVersion = localBytes.toString("utf8").match(CLI_VERSION_PATTERN)?.[1];
  if (!localVersion || !CLI_VERSION_FORMAT.test(localVersion)) {
    fail(`${CLI_SOURCE_PATH} must declare CLI_VERSION as YYYY.MM.DD[.N]; found ${localVersion ?? "no marker"}`);
  }

  const origin = process.env.KLIPPEE_BASE_URL || configuredOrigin;
  if (!origin || origin === "https://klippee.example.com") {
    console.log("ok - local CLI version is valid (no deployed instance configured)");
    return;
  }
  const deployedCliUrl = new URL("/install/klippee.py", deploymentOrigin(origin));
  let deployedBytes;
  try {
    const response = await fetch(deployedCliUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.warn(`warn - skipped CLI version guard: ${deployedCliUrl} returned HTTP ${response.status}`);
      return;
    }
    deployedBytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.warn(`warn - skipped CLI version guard: could not fetch ${deployedCliUrl} (${error?.cause?.message ?? error?.message ?? error})`);
    return;
  }

  // Compare with line endings normalized: Windows checkouts materialize the
  // repo's LF blobs as CRLF, while the deployed asset is built from the LF
  // blob on Linux — raw byte equality would report a phantom diff (and a
  // false "bump CLI_VERSION" failure) on every Windows machine right after
  // a deploy.
  const normalizeEol = (bytes) => bytes.toString("utf8").replaceAll("\r\n", "\n");
  if (normalizeEol(deployedBytes) === normalizeEol(localBytes)) {
    console.log(`ok - deployed CLI matches ${CLI_SOURCE_PATH} (version ${localVersion})`);
    return;
  }

  const deployedVersion = deployedBytes.toString("utf8").match(CLI_VERSION_PATTERN)?.[1];
  if (!deployedVersion || !CLI_VERSION_FORMAT.test(deployedVersion)) {
    console.warn(`warn - skipped CLI version guard: no parseable CLI_VERSION in the deployed ${deployedCliUrl}`);
    return;
  }

  if (cliVersionCompare(localVersion, deployedVersion) <= 0) {
    fail(
      `${CLI_SOURCE_PATH} differs from the deployed CLI but CLI_VERSION is not strictly greater `
      + `(local ${localVersion} vs deployed ${deployedVersion}); installed printers refuse `
      + "same-version or downgrade upgrades, so bump CLI_VERSION",
    );
  }

  console.log(`ok - CLI changes bump CLI_VERSION (${deployedVersion} -> ${localVersion})`);
}

async function main() {
  const config = await readWranglerConfig();
  assertWranglerBindings(config);
  const [migrations] = await Promise.all([
    assertMigrations(),
    assertCloudflareDeploymentDocs(),
    assertDeployAppliesMigrations(),
    assertCadIsStateless(),
    assertCliVersionBumped(config.vars.APP_ORIGIN),
  ]);
  await assertHealthMigrationMarker(migrations.at(-1));

  console.log(`ok - ${migrations.length} D1 migrations are present and contiguous`);
  console.log(`ok - Worker health requires the newest D1 migration ${migrations.at(-1)}`);
  console.log("ok - wrangler production bindings include ASSETS, DB, BLOBS, CAD_CONTAINER, and CANONICAL_BLOB_RECLAIMER");
  console.log("ok - authenticated diagnostic upload rate-limit bindings are configured and unique");
  console.log("ok - CAD processing is stateless and does not access D1 or R2");
  console.log("ok - Cloudflare Workers Builds deployment is documented");
  console.log("ok - 'npm run deploy' applies remote D1 migrations before 'wrangler deploy'");
}

await main();
