import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
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

it("gates every mutating Moonraker RPC on a fresh fail-closed printer-state query", async () => {
  const result = await run(python, [fixturePath("moonraker_state_gate.py"), installer]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

it("frames Moonraker agent responses and preserves operation tracking", async () => {
  const result = await run(python, [fixturePath("moonraker_agent_framing.py"), installer]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

it("uses the Moonraker Unix socket when localhost HTTP is unavailable", async () => {
  const result = await run(python, [fixturePath("moonraker_unix_socket.py"), installer]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

it("installs an idempotent Moonraker agent and dashboard macros", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-moonraker-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(home, "printer_data", "config");
  const comms = join(home, "printer_data", "comms");
  const server = await startServer((_request, response) => sendJson(response, 404, { error: "Unexpected request" }));
  try {
    await mkdir(config, { recursive: true });
    await mkdir(comms, { recursive: true });
    await writeFile(join(config, "printer.cfg"), "[printer]\nkinematics: corexy\n");
    await writeFile(join(comms, "moonraker.sock"), "");
    const systemctl = fixturePath("systemctl_log_stub.py");
    const systemctlLog = join(root, "systemctl.log");
    const env = {
      ...testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state }),
      KLIPPEE_SYSTEMCTL_COMMAND: JSON.stringify([python, systemctl]),
      KLIPPEE_SYSTEMCTL_LOG: systemctlLog,
    };

    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const cli = installedCli(prefix);
    const moonrakerInstall = await run(python, [cli, "install-moonraker"], { env });
    assert.equal(moonrakerInstall.status, 0, moonrakerInstall.stderr || moonrakerInstall.stdout);
    assert.match(moonrakerInstall.stdout, /installed Moonraker agent service/);
    assert.match(moonrakerInstall.stdout, /restart Klipper once/);

    const macros = await readFile(join(config, "klippee-macros.cfg"), "utf8");
    for (const macro of ["KLIPPEE_CHECK", "KLIPPEE_CAPTURE", "KLIPPEE_APPLY", "KLIPPEE_UPLOAD_DIAGNOSTICS"]) {
      assert.match(macros, new RegExp(`\\[gcode_macro ${macro}\\]`));
    }
    assert.match(macros, /\[respond\]/);
    const printerConfig = await readFile(join(config, "printer.cfg"), "utf8");
    assert.equal((printerConfig.match(/\[include klippee-macros\.cfg\]/g) ?? []).length, 1);
    const unit = await readFile(join(home, ".config", "systemd", "user", "klippee-moonraker.service"), "utf8");
    assert.match(unit, /moonraker-agent/);
    assert.match(unit, /KLIPPEE_MOONRAKER_SOCKET=/);
    assert.match(unit, /KLIPPEE_STATE_DIR=/);
    assert.match(unit, /Restart=on-failure/);
    const systemctlCalls = await readFile(systemctlLog, "utf8");
    assert.match(systemctlCalls, /"enable", "klippee-moonraker\.service"/);
    assert.match(systemctlCalls, /"restart", "klippee-moonraker\.service"/);

    const timerInstall = await run(python, [cli, "install-timer"], { env });
    assert.equal(timerInstall.status, 0, timerInstall.stderr || timerInstall.stdout);
    assert.match(timerInstall.stdout, /read-only status timer installed/);
    const syncService = await readFile(join(home, ".config", "systemd", "user", "klippee-sync.service"), "utf8");
    assert.match(syncService, /^ExecStart=.* check$/m);
    assert.doesNotMatch(syncService, /\b(?:apply|capture)\b/);
    const timerUnit = await readFile(join(home, ".config", "systemd", "user", "klippee-sync.timer"), "utf8");
    assert.match(timerUnit, /^OnUnitActiveSec=10min$/m);
    const timerSystemctlCalls = await readFile(systemctlLog, "utf8");
    assert.match(timerSystemctlCalls, /"enable", "--now", "klippee-sync\.timer"/);

    const reinstall = await run(python, [cli, "install-moonraker"], { env });
    assert.equal(reinstall.status, 0, reinstall.stderr || reinstall.stdout);
    const reinstalledMacros = await readFile(join(config, "klippee-macros.cfg"), "utf8");
    assert.equal((reinstalledMacros.match(/\[respond\]/g) ?? []).length, 1);
    assert.equal(((await readFile(join(config, "printer.cfg"), "utf8")).match(/\[include klippee-macros\.cfg\]/g) ?? []).length, 1);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});
