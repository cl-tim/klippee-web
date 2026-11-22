import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const workerRoot = fileURLToPath(new URL("../../worker/", import.meta.url));
function applicationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return applicationFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

it("centralizes explicit D1 preparation and session access in the Drizzle adapter", () => {
  const violations = [];
  for (const file of applicationFiles(workerRoot)) {
    const name = relative(workerRoot, file).replaceAll("\\", "/");
    if (name === "db.ts") continue;
    const source = readFileSync(file, "utf8");
    for (const pattern of [/\.\s*prepare\s*\(/, /\.\s*withSession\s*\(/, /\.\s*DB\b/, /\bD1PreparedStatement\b/]) {
      if (pattern.test(source)) violations.push(`${name}: ${pattern}`);
    }
  }
  assert.deepEqual(violations, []);
});
