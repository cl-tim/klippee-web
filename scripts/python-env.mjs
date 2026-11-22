import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const venvPython =
  process.platform === "win32"
    ? join(root, ".venv", "Scripts", "python.exe")
    : join(root, ".venv", "bin", "python");

const python = existsSync(venvPython) ? venvPython : process.env.PYTHON || "python";
const commands = {
  "test-orca": ["-B", "-m", "unittest", "discover", "--start-directory", "plugins/orcaslicer", "--pattern", "test_*.py"],
  "dev-cad": ["-m", "uvicorn", "server.cad_app:app", "--host", "127.0.0.1", "--port", "8791"],
  // Discovery rather than a named module, so new server/tests files are picked
  // up by `npm run check` without editing this list.
  "test-cad": ["-m", "unittest", "discover", "--start-directory", "server/tests", "--top-level-directory", "."],
};

const command = process.argv[2];
if (!command || !(command in commands)) {
  console.error(`Usage: node scripts/python-env.mjs ${Object.keys(commands).join("|")}`);
  process.exit(2);
}

const result = spawnSync(python, commands[command], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
