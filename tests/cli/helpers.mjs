import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const python = process.platform === "win32" ? "python" : "python3";
export const installer = resolve("public", "install", "klippee.py");
export const bootstrap = resolve("public", "install", "klippee.sh");

export function fixturePath(name) {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export function installedCli(prefix) {
  return join(prefix, "bin", process.platform === "win32" ? "klippee.py" : "klippee");
}

export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const { input, ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stderr, stdout }));
    child.stdin.end(input ?? "");
  });
}

export async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

export async function startServer(handler) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/printer/info") {
      sendJson(response, 200, { result: { software_version: "v0.13.0-test", state: "ready" } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/server/info") {
      sendJson(response, 200, { result: { moonraker_version: "v0.9.3-test" } });
      return;
    }
    Promise.resolve(handler(request, response)).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
  };
}

export function testEnvironment({ baseUrl, config, home, prefix, state }) {
  return {
    ...process.env,
    HOME: home,
    KLIPPEE_BASE_URL: baseUrl,
    KLIPPEE_CONFIG_DIR: config,
    KLIPPEE_MOONRAKER_URL: baseUrl,
    KLIPPEE_PREFIX: prefix,
    KLIPPEE_REPOSITORY_ID: "repo_1",
    KLIPPEE_STATE_DIR: state,
    KLIPPEE_TOKEN: "klp_test",
  };
}
