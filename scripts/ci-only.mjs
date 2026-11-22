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
