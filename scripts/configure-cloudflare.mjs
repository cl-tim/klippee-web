import { writeFile } from "node:fs/promises";
import { deploymentOrigin } from "./deployment-origin.mjs";
import { readWranglerTemplate } from "./wrangler-config.mjs";

const deploymentSettings = new Set([
  "d1_databases",
  "observability",
  "placement",
  "r2_buckets",
  "ratelimits",
  "vars",
]);

function readOverrides(value) {
  if (!value) throw new Error("Set KLIPPEE_WRANGLER_OVERRIDES in the build environment.");

  let overrides;
  try {
    overrides = JSON.parse(value);
  } catch {
    throw new Error("KLIPPEE_WRANGLER_OVERRIDES must contain valid JSON.");
  }
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("KLIPPEE_WRANGLER_OVERRIDES must be a JSON object.");
  }
  if (Object.keys(overrides).some((key) => !deploymentSettings.has(key))) {
    throw new Error("KLIPPEE_WRANGLER_OVERRIDES contains a setting that belongs in the source configuration.");
  }
  return overrides;
}

function validateTarget(config, template) {
  let origin;
  try {
    origin = deploymentOrigin(config.vars?.APP_ORIGIN);
  } catch {
    throw new Error("Set vars.APP_ORIGIN to your deployment's HTTPS origin.");
  }
  if (origin.protocol !== "https:" || origin.origin === template.vars.APP_ORIGIN) {
    throw new Error("Replace the example APP_ORIGIN with your deployment's HTTPS origin.");
  }

  const database = Array.isArray(config.d1_databases)
    ? config.d1_databases.find((binding) => binding?.binding === "DB")
    : undefined;
  if (!database?.database_name || database.database_id === template.d1_databases[0].database_id
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(database.database_id ?? "")) {
    throw new Error("Set the existing D1 database name and ID for the DB binding.");
  }

  const bucket = Array.isArray(config.r2_buckets)
    ? config.r2_buckets.find((binding) => binding?.binding === "BLOBS")
    : undefined;
  if (!bucket?.bucket_name || bucket.bucket_name === template.r2_buckets[0].bucket_name) {
    throw new Error("Set the existing R2 bucket name for the BLOBS binding.");
  }
}

const overrides = readOverrides(process.env.KLIPPEE_WRANGLER_OVERRIDES);
const template = await readWranglerTemplate();
const config = { ...template, ...overrides };
validateTarget(config, template);
await writeFile("wrangler.json", `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log("Prepared the Cloudflare build configuration.");
