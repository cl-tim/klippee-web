import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  bootstrap,
  fixturePath,
  installedCli,
  installer,
  python,
  run,
  sendJson,
  startServer,
  testEnvironment,
} from "./helpers.mjs";

it("compiles the Python client", async () => {
  const result = await run(python, ["-m", "py_compile", installer]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

it("keeps the printer client compatible with Python 3.7", async () => {
  const result = await run(python, [fixturePath("py37_compat.py"), installer]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const source = await readFile(installer, "utf8");
  assert.doesNotMatch(source, /:=/, "Python 3.8 assignment expressions are not supported on stock QIDI hosts");
  assert.doesNotMatch(source, /unlink\s*\([^)]*missing_ok\s*=/, "pathlib missing_ok requires Python 3.8");
  assert.doesNotMatch(
    source,
    /f"Authorization: Bearer \{config\.token\}"/,
    "sync tokens must not be exposed in curl process arguments",
  );
  assert.match(
    source,
    /command = \[curl, "--disable"\]/,
    "every curl invocation must ignore user-controlled curl config files",
  );
});

it("keeps the updater origin independent from workspace sync configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-updater-origin-"));
  const workspace = join(root, "workspace");
  try {
    await mkdir(join(workspace, ".klippee"), { recursive: true });
    await writeFile(join(workspace, ".klippee", "config.json"), JSON.stringify({
      base_url: "https://attacker.invalid",
      client_mode: "desktop",
      config_dir: workspace,
      repository_id: "repo_attacker",
      token: "attacker-token",
    }));
    const env = { ...process.env };
    delete env.KLIPPEE_STATE_DIR;
    delete env.KLIPPEE_UPGRADE_BASE_URL;
    delete env.KLIPPEE_ALLOW_INSECURE_UPGRADE;
    const result = await run(python, [fixturePath("updater_origin.py"), installer, workspace], { env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["https://klippee.xyz", "https://klippee.xyz"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("hardens the shell bootstrap download origin and temporary file", async () => {
  const source = await readFile(bootstrap, "utf8");
  assert.match(source, /KLIPPEE_INSTALL_BASE_URL/);
  assert.doesNotMatch(source, /base_url="\$\{KLIPPEE_BASE_URL/);
  assert.match(source, /KLIPPEE_ALLOW_INSECURE_INSTALL/);
  assert.match(source, /curl --disable --fail/);
  assert.match(source, /--proto "\$curl_protocol"/);
  assert.match(source, /--proto-redir "\$curl_protocol"/);
  assert.match(source, /--max-redirs 0/);
  assert.match(source, /--max-filesize 2000000/);
  assert.match(source, /mktemp/);
  assert.doesNotMatch(source, /klippee-install-\$\$/);
  assert.doesNotMatch(source, /curl\s+-[^\n]*L/);
  if (process.platform !== "win32") {
    const syntax = await run("sh", ["-n", bootstrap]);
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
  }
});

it("installs itself when streamed to python standard input", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-stream-"));
  const source = await readFile(installer, "utf8");
  const server = await startServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/install/klippee.py") {
      response.writeHead(200, { "content-type": "text/x-python" });
      response.end(source);
      return;
    }
    sendJson(response, 404, { error: "Unexpected request" });
  });
  try {
    const prefix = join(root, "prefix");
    const result = await run(python, ["-", "install"], {
      env: {
        ...process.env,
        HOME: join(root, "home"),
        KLIPPEE_ALLOW_INSECURE_INSTALL: "1",
        KLIPPEE_BASE_URL: "https://attacker.invalid",
        KLIPPEE_INSTALL_BASE_URL: server.baseUrl,
        KLIPPEE_PREFIX: prefix,
        KLIPPEE_REPOSITORY_ID: "",
        KLIPPEE_TOKEN: "",
      },
      input: source,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /starting installation/);
    assert.match(result.stdout, /installed CLI at/);
    assert.match(result.stdout, /configuration not provided; CLI installation only/);
    assert.match(result.stdout, /INSTALLATION SUCCESSFUL/);
    const installed = installedCli(prefix);
    assert.match(await readFile(installed, "utf8"), /Klippee's dependency-light config sync client/);
    if (process.platform === "win32") {
      const launcher = await readFile(join(prefix, "bin", "klippee.cmd"), "utf8");
      assert.doesNotMatch(launcher, /where py|^py\b|^python\b/m);
      assert.match(launcher, /^"[^"]+python(?:\.exe)?" "%~dp0klippee\.py" %\*/im);
    }
    const noCommand = await run(python, [installed]);
    assert.equal(noCommand.status, 0, noCommand.stderr || noCommand.stdout);
    assert.match(noCommand.stdout, /Usage: klippee <command> \[options\]/);
    assert.match(noCommand.stdout, /help, -h, --help/);
    const help = await run(python, [installed, "--help"]);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: klippee <command>/);
    for (const command of ["target", "check", "apply", "capture", "recover"]) {
      assert.match(help.stdout, new RegExp(`^ {2}${command}\\b`, "m"));
    }
    assert.doesNotMatch(help.stdout, /^ {2}(?:config|status|pull|push|diff|versions|rollback|restore-backup)\b/m);
    const removedCommand = await run(python, [installed, "push"]);
    assert.notEqual(removedCommand.status, 0);
    assert.match(removedCommand.stderr, /unknown command: push/);

    const maliciousCandidate = join(root, "local-candidate.py");
    await writeFile(maliciousCandidate, source.replace(
      "MAX_CLI_BYTES = 2_000_000",
      "# untrusted local candidate\nMAX_CLI_BYTES = 2_000_000",
    ));
    const isolatedPrefix = join(root, "isolated-prefix");
    const guardedInstall = await run(python, [fixturePath("guarded_install.py"), installer, maliciousCandidate], {
      env: {
        ...process.env,
        HOME: join(root, "home"),
        KLIPPEE_ALLOW_INSECURE_INSTALL: "1",
        KLIPPEE_BASE_URL: "https://attacker.invalid",
        KLIPPEE_INSTALL_BASE_URL: server.baseUrl,
        KLIPPEE_PREFIX: isolatedPrefix,
        KLIPPEE_REPOSITORY_ID: "",
        KLIPPEE_TOKEN: "",
      },
    });
    assert.equal(guardedInstall.status, 0, guardedInstall.stderr || guardedInstall.stdout);
    assert.doesNotMatch(await readFile(installedCli(isolatedPrefix), "utf8"), /untrusted local candidate/);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("upgrades the installed CLI atomically and preserves it when validation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-upgrade-"));
  const source = await readFile(installer, "utf8");
  const currentVersion = source.match(/^CLI_VERSION = "([^"]+)"$/m)?.[1];
  assert.ok(currentVersion, "CLI version declaration not found");
  const upgradedSource = source
    .replace(/^CLI_VERSION = "[^"]+"$/m, 'CLI_VERSION = "2099.01.01"')
    .replace("MAX_CLI_BYTES = 2_000_000", "# upgrade test marker\nMAX_CLI_BYTES = 2_000_000");
  let servedSource = upgradedSource;
  const server = await startServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/install/klippee.py") {
      response.writeHead(200, { "content-type": "text/x-python" });
      response.end(servedSource);
      return;
    }
    sendJson(response, 404, { error: "Unexpected request" });
  });
  try {
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    const state = join(root, "state");
    const config = join(root, "printer-config");
    const systemctl = fixturePath("systemctl_upgrade_stub.py");
    const systemctlLog = join(root, "systemctl.log");
    const agentUnit = join(home, ".config", "systemd", "user", "klippee-moonraker.service");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(agentUnit, "[Unit]\nDescription=Klippee Moonraker integration agent\n");
    const env = {
      ...testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state }),
      KLIPPEE_AGENT_TEST_STATE: "active",
      KLIPPEE_ALLOW_INSECURE_UPGRADE: "1",
      KLIPPEE_SYSTEMCTL_COMMAND: JSON.stringify([python, systemctl]),
      KLIPPEE_SYSTEMCTL_LOG: systemctlLog,
      KLIPPEE_UPGRADE_BASE_URL: server.baseUrl,
    };
    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const cli = installedCli(prefix);
    const upgrade = await run(python, [cli, "upgrade"], { env });
    assert.equal(upgrade.status, 0, upgrade.stderr || upgrade.stdout);
    assert.match(upgrade.stdout, /checking .*\/install\/klippee\.py/);
    assert.match(upgrade.stdout, new RegExp(`version ${currentVersion.replaceAll(".", "\\.")} -> 2099\\.01\\.01`));
    assert.match(upgrade.stdout, /restarted active klippee-moonraker\.service/);
    assert.match(upgrade.stdout, /UPGRADE SUCCESSFUL/);
    assert.match(await readFile(cli, "utf8"), /# upgrade test marker/);
    const upgradedHelp = await run(python, [cli, "--help"], { env });
    assert.equal(upgradedHelp.status, 0, upgradedHelp.stderr || upgradedHelp.stdout);
    assert.match(upgradedHelp.stdout, /^Usage: klippee/m);

    const alreadyCurrent = await run(python, [cli, "upgrade"], { env });
    assert.equal(alreadyCurrent.status, 0, alreadyCurrent.stderr || alreadyCurrent.stdout);
    assert.match(alreadyCurrent.stdout, /already up to date \(version 2099\.01\.01\)/);
    assert.match(alreadyCurrent.stdout, /restarted active klippee-moonraker\.service/);
    assert.match(alreadyCurrent.stdout, /UPGRADE SUCCESSFUL/);

    const activeSystemctlCalls = (await readFile(systemctlLog, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(activeSystemctlCalls.filter((call) => call[1] === "try-restart").length, 2);

    const inactiveUpgrade = await run(python, [cli, "upgrade"], {
      env: { ...env, KLIPPEE_AGENT_TEST_STATE: "inactive" },
    });
    assert.equal(inactiveUpgrade.status, 0, inactiveUpgrade.stderr || inactiveUpgrade.stdout);
    assert.match(inactiveUpgrade.stdout, /installed but not active \(inactive\); it was not restarted/);
    assert.match(inactiveUpgrade.stdout, /start klippee-moonraker\.service manually/);
    const inactiveSystemctlCalls = (await readFile(systemctlLog, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(inactiveSystemctlCalls.filter((call) => call[1] === "try-restart").length, 2);

    const failedRestart = await run(python, [cli, "upgrade"], {
      env: { ...env, KLIPPEE_AGENT_TEST_RESTART_FAIL: "1" },
    });
    assert.notEqual(failedRestart.status, 0);
    assert.match(failedRestart.stderr, /active Moonraker agent could not be restarted: simulated restart failure/);
    assert.match(failedRestart.stderr, /UPGRADE FAILED/);

    const validInstalledSource = await readFile(cli, "utf8");
    servedSource = validInstalledSource.replace(
      "MAX_CLI_BYTES = 2_000_000",
      "# same-version replacement test marker\nMAX_CLI_BYTES = 2_000_000",
    );
    const sameVersionReplacement = await run(python, [cli, "upgrade"], { env });
    assert.notEqual(sameVersionReplacement.status, 0);
    assert.match(sameVersionReplacement.stderr, /same-version replacement/);
    assert.match(sameVersionReplacement.stderr, /UPGRADE FAILED/);
    assert.equal(await readFile(cli, "utf8"), validInstalledSource);

    servedSource = source;
    const downgrade = await run(python, [cli, "upgrade"], { env });
    assert.notEqual(downgrade.status, 0);
    assert.match(downgrade.stderr, /refusing CLI downgrade/);
    assert.match(downgrade.stderr, /UPGRADE FAILED/);
    assert.equal(await readFile(cli, "utf8"), validInstalledSource);

    servedSource = "this is not a Klippee Python client\n";
    const rejected = await run(python, [cli, "upgrade"], { env });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /is not the Klippee CLI/);
    assert.match(rejected.stderr, /UPGRADE FAILED/);
    assert.equal(await readFile(cli, "utf8"), validInstalledSource);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("fails limit violations client-side and keeps the installer usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-limits-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  try {
    await mkdir(home, { recursive: true });
    await mkdir(config, { recursive: true });
    for (let index = 0; index < 65; index += 1) {
      await writeFile(join(config, `bulk-${String(index).padStart(2, "0")}.cfg`), "[bulk]\n");
    }
    const env = {
      ...testEnvironment({ baseUrl: "http://127.0.0.1:1", config, home, prefix, state }),
      KLIPPEE_CAPTURE_CURRENT: "1",
    };
    const install = await run(python, [installer, "install"], { env });
    assert.notEqual(install.status, 0);
    assert.match(install.stderr, /at most 64 per capture/);
    assert.match(install.stderr, /initial import failed/);
    assert.match(install.stderr, /INSTALLATION FAILED/);
    assert.match(install.stderr, /CLI was installed, but the initial configuration sync did not complete/);
    assert.match(install.stdout, /is not on your PATH/);
    assert.match(install.stdout, /try '.*klippee(?:\.cmd)? target'/);

    const cli = installedCli(prefix);
    for (let index = 1; index < 65; index += 1) {
      await rm(join(config, `bulk-${String(index).padStart(2, "0")}.cfg`));
    }
    await writeFile(join(config, "bulk-00.cfg"), "x".repeat(300000));
    const oversizedCapture = await run(python, [cli, "capture"], { env });
    assert.notEqual(oversizedCapture.status, 0);
    assert.match(oversizedCapture.stderr, /server accepts files up to 256000 bytes/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
