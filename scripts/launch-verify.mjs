import { spawnSync } from "node:child_process";
import { deploymentOrigin } from "./deployment-origin.mjs";

const baseUrl = deploymentOrigin(process.env.KLIPPEE_BASE_URL, "Set KLIPPEE_BASE_URL to the instance to verify.").origin;

function run(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    env: {
      ...process.env,
      ...options.env,
    },
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(result.status ?? 1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Verifying launch readiness for ${baseUrl}`);
run("predeploy configuration gate", "npm", ["run", "predeploy"]);
run("required live smoke checks", "node", ["scripts/smoke-prod.mjs"], {
  env: {
    KLIPPEE_BASE_URL: baseUrl,
    KLIPPEE_REQUIRE_PUBLIC_PACKAGE: "1",
  },
});

console.log("\nok - launch verification passed");
