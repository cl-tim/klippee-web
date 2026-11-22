import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const venvDir = join(root, ".venv");
const venvPython =
  process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function canRun(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "ignore" });
  return !result.error && result.status === 0;
}

function findPython() {
  const candidates =
    process.platform === "win32"
      ? [
          ["py", ["-3.12", "--version"]],
          ["python", ["--version"]],
        ]
      : [
          ["python3.12", ["--version"]],
          ["python3", ["--version"]],
          ["python", ["--version"]],
        ];

  for (const [command, args] of candidates) {
    if (canRun(command, args)) {
      return [command, args.slice(0, -1)];
    }
  }
  throw new Error("Python was not found. Install Python 3.12 or newer and rerun npm run setup:dev.");
}

if (!existsSync(join(root, ".dev.vars"))) {
  copyFileSync(join(root, ".dev.vars.example"), join(root, ".dev.vars"));
  console.log("created .dev.vars from .dev.vars.example");
}

if (!existsSync(venvPython)) {
  const [pythonCommand, pythonArgs] = findPython();
  run(pythonCommand, [...pythonArgs, "-m", "venv", ".venv"]);
  console.log("created .venv");
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
run(venvPython, ["-m", "pip", "install", "-r", "server/cad-requirements.txt"]);
run(npmCommand, ["exec", "--", "wrangler", "d1", "migrations", "apply", "DB", "--local"]);

console.log("development environment is ready");
