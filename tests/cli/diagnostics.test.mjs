import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { unzipSync } from "fflate";
import {
  fixturePath,
  installedCli,
  installer,
  python,
  run,
  sendJson,
  startServer,
  testEnvironment,
} from "./helpers.mjs";

it("includes only allowlisted QIDI Box variables in diagnostic snapshots", async () => {
  const result = await run(python, [fixturePath("diagnostic_save_variables.py"), installer]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

it("collects bounded persistent USB evidence and includes both rotations in diagnostic bundles", async () => {
  const result = await run(python, [fixturePath("diagnostic_usb_events.py"), installer]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

it("uploads a private diagnostic bundle with Klippy, Moonraker, and runtime evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-diagnostic-upload-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(home, "printer_data", "config");
  const logs = join(home, "printer_data", "logs");
  const logText = "Stats 1.0: heater_bed: target=60 temp=55\\nTransition to shutdown state: ADC out of range\\n";
  const moonrakerText = "2026-07-25 12:00:00 [server.py:info()] Moonraker warning\\n";
  let uploaded = null;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname === "/api/sync/repos/repo_1/diagnostics") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      uploaded = {
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks),
        contentType: request.headers["content-type"],
        fileName: request.headers["x-klippee-log-name"],
      };
      sendJson(response, 201, {
        upload: { id: "diagnostic_1" },
        url: `${server.baseUrl}/log-diagnostics?upload=diagnostic_1`,
      });
      return;
    }
    sendJson(response, 404, { error: "Unexpected request" });
  });
  try {
    await mkdir(config, { recursive: true });
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "klippy.log"), logText);
    await writeFile(join(logs, "moonraker.log"), moonrakerText);
    const env = testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state });
    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const upload = await run(python, [installedCli(prefix), "upload-diagnostics"], { env });
    assert.equal(upload.status, 0, upload.stderr || upload.stdout);
    assert.match(upload.stdout, /collected \d+ diagnostic artifacts/);
    assert.match(upload.stdout, /diagnostic bundle uploaded privately for 48 hours/);
    assert.match(upload.stdout, /log-diagnostics\?upload=diagnostic_1/);
    assert.match(upload.stdout, /DIAGNOSTIC UPLOAD SUCCESSFUL/);
    assert.equal(uploaded.authorization, "Bearer klp_test");
    assert.equal(uploaded.contentType, "application/zip");
    assert.match(uploaded.fileName, /^klippee-diagnostics-\d{8}T\d{6}Z\.zip$/);
    const bundle = unzipSync(new Uint8Array(uploaded.body));
    assert.equal(Buffer.from(bundle["logs/klippy.log"]).toString("utf8"), logText);
    assert.equal(Buffer.from(bundle["logs/moonraker.log"]).toString("utf8"), moonrakerText);
    const manifest = JSON.parse(Buffer.from(bundle["manifest.json"]).toString("utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.client.mode, "printer");
    assert.equal(manifest.client.repositoryId, "repo_1");
    assert.ok(manifest.artifacts.some((artifact) => artifact.archiveName === "snapshots/host-info.json"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.archiveName === "snapshots/host-scheduling.json"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.archiveName === "snapshots/usb-serial-topology.json"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.archiveName === "snapshots/printer-info.json"));
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});
