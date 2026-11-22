import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import { requestLocalApp } from "./self-host-smoke-http.mjs";

const [appImage, cadImage] = process.argv.slice(2);
assert.ok(appImage && cadImage, "Usage: node scripts/self-host-container-smoke.mjs <app-image> <cad-image>");
const directory = await mkdtemp(join(tmpdir(), "klippee-container-smoke-"));
const project = `klippee-smoke-${process.pid}`;
const port = Number(process.env.KLIPPEE_CONTAINER_SMOKE_PORT ?? 4189);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
const splitImage = (value) => {
  const index = value.lastIndexOf(":");
  assert.ok(index > value.lastIndexOf("/"), "Smoke-test image needs an explicit tag");
  return [value.slice(0, index), value.slice(index + 1)];
};
const [appName, tag] = splitImage(appImage);
const [cadName, cadTag] = splitImage(cadImage);
assert.equal(cadTag, tag, "Use matching app and CAD tags");
const compose = (...args) => execFileSync("docker", ["compose", "--project-name", project, "--project-directory", directory, "-f", join(directory, "compose.yaml"), ...args], {
  stdio: "inherit", timeout: 240_000,
});
try {
  await writeFile(join(directory, "compose.yaml"), await readFile(resolve("compose.yaml")));
  await writeFile(join(directory, ".env"), [
    "APP_ORIGIN=https://klippee.example.com",
    "AUTH_MODE=local",
    "SESSION_SECRET=container-smoke-only-0123456789abcdef0123456789abcdef",
    `KLIPPEE_IMAGE=${appName}`, `KLIPPEE_CAD_IMAGE=${cadName}`, `KLIPPEE_VERSION=${tag}`, `KLIPPEE_PORT=${port}`,
  ].join("\n") + "\n", { mode: 0o600 });
  compose("up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180");
  const request = async (path, options) => {
    const response = await requestLocalApp(port, path, {
      ...options,
      headers: { host: "klippee.example.com", ...options?.headers },
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  };
  assert.equal((await (await request("/api/health")).json()).ok, true);
  assert.equal((await (await request("/api/cad/health")).json()).ok, true);
  const html = await request("/printers");
  assert.match(await html.text(), /<div id="root">/);
  assert.match(html.headers.get("content-security-policy"), /nonce-/);
  assert.equal((await (await request("/api/auth/me")).json()).user.mode, "local");
  console.log("ok - Local workspace opens without OAuth credentials, and storage, frontend and CAD are healthy");
  const render = await request("/api/cad/render?mode=preview", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://klippee.example.com" },
    body: JSON.stringify({ files: [{ name: "main.scad", source: "cube([5, 5, 5]);" }], mainFile: "main.scad", parameters: {} }),
  });
  assert.match(render.headers.get("content-type"), /model\/stl/);
  assert.ok((await render.arrayBuffer()).byteLength >= 84);
  console.log("ok - OpenSCAD renders an STL through the standalone API");
  // The images must not include personal development credentials or deploy config.
  compose("exec", "-T", "app", "node", "-e", "const fs=require('node:fs'); for(const p of ['.env','.dev.vars','dist/klippee/.dev.vars','dist/klippee/wrangler.json','.git','artifacts']) if(fs.existsSync(p)) process.exit(1)");
  compose("restart", "app");
  compose("up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120");
  // Docker can briefly retain the old healthy state across a restart. Wait
  // for the newly started application, independently of that cached state.
  let restartError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assert.equal((await (await request("/api/health")).json()).ok, true);
      restartError = undefined;
      break;
    } catch (error) {
      restartError = error;
      await setTimeout(1000);
    }
  }
  if (restartError) throw restartError;
  console.log("ok - Compose restart retains the migration ledger and storage");
} catch (error) {
  try { compose("logs", "--tail", "60"); } catch { /* Preserve the original failure. */ }
  throw error;
} finally {
  compose("down", "--volumes", "--remove-orphans");
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}
