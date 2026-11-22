import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

// Refuses to run outside CI. `npm run deploy` is the Cloudflare Workers
// Builds deploy command: it applies remote D1 migrations and publishes the
// Worker, and it assumes `npm run build` already ran in the same pipeline.
// Run locally on a stale checkout it would migrate production and ship
// whatever happens to be in dist/. Workers Builds sets CI=true (and
// WORKERS_CI=1); a deliberate local deployment should use
// `npm run deploy:manual`, which builds first.

function isTruthyEnv(value) {
  return typeof value === "string" && value !== "" && value.toLowerCase() !== "false" && value !== "0";
}

if (!isTruthyEnv(process.env.WORKERS_CI) && !isTruthyEnv(process.env.CI)) {
  console.error(
    "refusing to deploy: 'npm run deploy' is reserved for CI (Cloudflare Workers Builds).\n"
    + "For a deliberate local deployment use 'npm run deploy:manual', which runs the\n"
    + "predeploy guard and a fresh build before migrating and deploying.",
  );
  process.exit(1);
}
if (process.env.KLIPPEE_WRANGLER_OVERRIDES) {
  const expected = JSON.parse(await readFile("wrangler.json", "utf8"));
  const redirect = JSON.parse(await readFile(".wrangler/deploy/config.json", "utf8"));
  const bundled = JSON.parse(await readFile(resolve(".wrangler/deploy", redirect.configPath), "utf8"));
  const bindings = ["name", "vars", "r2_buckets", "durable_objects", "migrations", "ratelimits"];
  const d1Targets = (config) => config.d1_databases.map(({ binding, database_id }) => [binding, database_id]);
  if (bindings.some((key) => !isDeepStrictEqual(expected[key], bundled[key]))
    || !isDeepStrictEqual(d1Targets(expected), d1Targets(bundled))) {
    throw new Error("The Worker bundle does not match the Cloudflare build configuration. Run npm run build:cloudflare before deploying.");
  }
}
