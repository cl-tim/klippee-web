import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  installedCli,
  installer,
  python,
  requestJson,
  run,
  sendJson,
  startServer,
  testEnvironment,
} from "./helpers.mjs";

it("reads legacy shell-client configuration without executing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-legacy-"));
  const state = join(root, "state");
  const config = join(root, "printer-config");
  try {
    await mkdir(state, { recursive: true });
    await mkdir(config, { recursive: true });
    await mkdir(join(config, ".klippee"), { recursive: true });
    await writeFile(join(config, ".klippee", "variables.env"), "existing_value=kept\n");
    await writeFile(
      join(state, "config"),
      `KLIPPEE_BASE_URL='https://klippee.xyz'\nKLIPPEE_REPOSITORY_ID='repo_1'\nKLIPPEE_TOKEN='klp_test'\nKLIPPEE_CONFIG_DIR='${config.replaceAll("\\", "/")}'\n`,
    );
    await chmod(join(state, "config"), 0o600);
    const result = await run(python, [installer, "variables", "set", "printer_name", "Legacy Config"], {
      env: { ...process.env, KLIPPEE_STATE_DIR: state },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(
      (await readFile(join(config, "klippee_variables.cfg"), "utf8")).replaceAll("\r\n", "\n"),
      [
        "# Klippee local variable values. Edit the entries below.",
        "# Format: # KLIPPEE_VARIABLE name=value",
        "# This file stays on this computer and is never included by klippee capture.",
        "# Every entry is a comment so broad Klipper include patterns remain safe.",
        "# KLIPPEE_VARIABLE existing_value=kept",
        "# KLIPPEE_VARIABLE printer_name=Legacy Config",
        "",
      ].join("\n"),
    );
    await assert.rejects(stat(join(config, ".klippee", "variables.env")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("keeps visible local variables and cloud placeholders across apply and capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-variables-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  let remoteFiles = [{
    content: "[printer]\nserial = ${KLIPPEE:mcu_serial}\nmax_velocity = 100\n",
    path: "printer.cfg",
    public: false,
    role: "main",
  }];
  let pushedFiles = null;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/pull")) {
      sendJson(response, 200, {
        printer: { variableValues: {} },
        version: { files: remoteFiles, version_number: 1 },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/status.txt")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("repository_id=repo_1\nprinter_id=printer_1\nprinter_name=Test printer\n");
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      const payload = await requestJson(request);
      pushedFiles = payload.files;
      remoteFiles = payload.files;
      sendJson(response, 201, { version: { files: remoteFiles, version_number: 2 } });
      return;
    }
    if (
      request.method === "POST"
      && (url.pathname.endsWith("/applied") || url.pathname.endsWith("/host-info"))
    ) {
      if (url.pathname.endsWith("/host-info")) await requestJson(request);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: `Unexpected request: ${request.method} ${url.pathname}` });
  });

  try {
    await mkdir(home, { recursive: true });
    await mkdir(config, { recursive: true });
    const env = testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state });
    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const cli = installedCli(prefix);

    const setVariable = await run(python, [cli, "variables", "set", "mcu_serial", "/dev/serial/one"], { env });
    assert.equal(setVariable.status, 0, setVariable.stderr || setVariable.stdout);
    const variablesFile = join(config, "klippee_variables.cfg");
    const firstVariables = await readFile(variablesFile, "utf8");
    assert.match(firstVariables, /# KLIPPEE_VARIABLE mcu_serial=\/dev\/serial\/one/);
    assert.ok(firstVariables.split(/\r?\n/).filter(Boolean).every((line) => line.startsWith("#")));

    const apply = await run(python, [cli, "apply", "--yes"], { env });
    assert.equal(apply.status, 0, apply.stderr || apply.stdout);
    const firstLocalConfig = await readFile(join(config, "printer.cfg"), "utf8");
    assert.match(firstLocalConfig, /serial = \/dev\/serial\/one/);
    await writeFile(join(config, "printer.cfg"), firstLocalConfig.replace("max_velocity = 100", "max_velocity = 110"));

    const capture = await run(python, [cli, "capture", "--note", "Tune velocity"], { env });
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);
    assert.ok(pushedFiles);
    assert.match(JSON.stringify(pushedFiles), /\$\{KLIPPEE:mcu_serial\}/);
    assert.doesNotMatch(JSON.stringify(pushedFiles), /\/dev\/serial\/one/);
    assert.doesNotMatch(JSON.stringify(pushedFiles), /klippee_variables\.cfg/);

    await writeFile(
      variablesFile,
      [
        "# Klippee local variable values. Edit the entries below.",
        "# Format: # KLIPPEE_VARIABLE name=value",
        "# This file stays on this computer and is never included by klippee capture.",
        "# Every entry is a comment so broad Klipper include patterns remain safe.",
        "# KLIPPEE_VARIABLE mcu_serial=/dev/serial/two",
        "",
      ].join("\n"),
    );
    const secondApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.equal(secondApply.status, 0, secondApply.stderr || secondApply.stdout);
    const secondLocalConfig = await readFile(join(config, "printer.cfg"), "utf8");
    assert.match(secondLocalConfig, /serial = \/dev\/serial\/two/);
    assert.match(secondLocalConfig, /max_velocity = 110/);
    assert.match(await readFile(variablesFile, "utf8"), /# KLIPPEE_VARIABLE mcu_serial=\/dev\/serial\/two/);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});
