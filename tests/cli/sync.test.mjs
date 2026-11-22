import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { it } from "node:test";
import {
  fixturePath,
  installedCli,
  installer,
  python,
  requestJson,
  run,
  sendJson,
  startServer,
  testEnvironment,
} from "./helpers.mjs";

it("refuses to write or load unsafe desktop workspace credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-tracked-token-"));
  const workspace = join(root, "workspace");
  const trackedConfig = join(workspace, ".klippee", "config.json");
  try {
    await mkdir(join(workspace, ".klippee"), { recursive: true });
    const initRepository = await run("git", ["init", "--quiet"], { cwd: workspace });
    assert.equal(initRepository.status, 0, initRepository.stderr || initRepository.stdout);
    await writeFile(trackedConfig, "tracked placeholder\n");
    const stage = await run("git", ["add", "--", ".klippee/config.json"], { cwd: workspace });
    assert.equal(stage.status, 0, stage.stderr || stage.stdout);
    const env = {
      ...process.env,
      HOME: join(root, "home"),
      KLIPPEE_BASE_URL: "https://klippee.xyz",
      KLIPPEE_CLIENT_MODE: "desktop",
      KLIPPEE_CONFIG_DIR: workspace,
      KLIPPEE_REPOSITORY_ID: "repo_tracked",
      KLIPPEE_TOKEN: "must-not-be-written",
    };
    delete env.KLIPPEE_STATE_DIR;
    const result = await run(python, [installer, "init", "--desktop"], { cwd: workspace, env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Git-tracked \.klippee\/config\.json/);
    assert.equal(await readFile(trackedConfig, "utf8"), "tracked placeholder\n");

    await writeFile(trackedConfig, JSON.stringify({
      base_url: "https://attacker.invalid",
      client_mode: "desktop",
      config_dir: join(root, "private-printer-config"),
      repository_id: "repo_attacker",
      token: "attacker-token",
    }));
    await chmod(trackedConfig, 0o600);
    const loadTracked = await run(python, [installer, "target"], { cwd: workspace, env });
    assert.notEqual(loadTracked.status, 0);
    assert.match(loadTracked.stderr, /refusing to load a sync token from a Git-tracked/);

    const untrackedWorkspace = join(root, "untracked-workspace");
    const untrackedConfig = join(untrackedWorkspace, ".klippee", "config.json");
    await mkdir(join(untrackedWorkspace, ".klippee"), { recursive: true });
    await writeFile(untrackedConfig, JSON.stringify({
      base_url: "https://attacker.invalid",
      client_mode: "desktop",
      config_dir: join(root, "private-printer-config"),
      repository_id: "repo_attacker",
      token: "attacker-token",
    }));
    await chmod(untrackedConfig, 0o600);
    const loadExternal = await run(python, [installer, "target"], { cwd: untrackedWorkspace, env });
    assert.notEqual(loadExternal.status, 0);
    assert.match(loadExternal.stderr, /must use desktop mode and point to that workspace/);

    if (process.platform === "win32") {
      const plantedPrograms = join(root, "planted-programs");
      await mkdir(plantedPrograms, { recursive: true });
      for (const name of ["git.cmd", "curl.cmd", "cksum.cmd"]) {
        await writeFile(join(plantedPrograms, name), "@echo planted\r\n");
      }
      const resolvedPrograms = await run(python, [fixturePath("resolve_programs.py"), installer, plantedPrograms], { env });
      assert.equal(resolvedPrograms.status, 0, resolvedPrograms.stderr || resolvedPrograms.stdout);
      for (const resolvedProgram of resolvedPrograms.stdout.trim().split(/\r?\n/).filter(Boolean)) {
        assert.equal(resolve(resolvedProgram).startsWith(resolve(plantedPrograms)), false);
      }

      const caseWorkspace = join(root, "case-workspace");
      const caseState = join(caseWorkspace, ".KLIPPEE");
      const caseConfig = join(caseState, "config.json");
      await mkdir(caseState, { recursive: true });
      const initCaseRepository = await run("git", ["init", "--quiet"], { cwd: caseWorkspace });
      assert.equal(initCaseRepository.status, 0, initCaseRepository.stderr || initCaseRepository.stdout);
      await writeFile(join(caseState, ".gitignore"), "*\n");
      await writeFile(caseConfig, JSON.stringify({
        base_url: "https://attacker.invalid",
        client_mode: "desktop",
        config_dir: caseWorkspace,
        repository_id: "repo_attacker",
        token: "attacker-token",
      }));
      const stageCaseConfig = await run(
        "git",
        ["add", "--force", "--", ".KLIPPEE/.gitignore", ".KLIPPEE/config.json"],
        { cwd: caseWorkspace },
      );
      assert.equal(stageCaseConfig.status, 0, stageCaseConfig.stderr || stageCaseConfig.stdout);
      const caseEnv = { ...env, KLIPPEE_CONFIG_DIR: caseWorkspace };
      const loadCaseVariant = await run(python, [installer, "target"], { cwd: caseWorkspace, env: caseEnv });
      assert.notEqual(loadCaseVariant.status, 0);
      assert.match(loadCaseVariant.stderr, /refusing to load a sync token from a Git-tracked/);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("keeps desktop connections scoped to their config folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-desktop-workspaces-"));
  const home = join(root, "home");
  const firstConfig = join(root, "printer-one");
  const secondConfig = join(root, "printer-two");
  const nestedSecondConfig = join(secondConfig, "macros");
  const server = await startServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const match = url.pathname.match(/^\/api\/sync\/repos\/([^/]+)\/status\.txt$/);
    if (request.method === "GET" && match) {
      response.writeHead(200, { "content-type": "text/plain" });
      const versions = match[1] === "repo_one"
        ? "applied_version=4\napplied_at=2026-08-05T10:00:00Z\ntarget_version=5\ntarget_pending=1\ntarget_created_at=2026-08-06T10:00:00Z\n"
        : "applied_version=7\ntarget_version=7\ntarget_pending=0\n";
      response.end(`repository_id=${match[1]}\nprinter_id=printer_${match[1]}\nprinter_name=${match[1]}\n${versions}`);
      return;
    }
    sendJson(response, 404, { error: "Unexpected request" });
  });

  function desktopEnvironment(repositoryId, token, config) {
    const env = {
      ...process.env,
      HOME: home,
      KLIPPEE_BASE_URL: server.baseUrl,
      KLIPPEE_CLIENT_MODE: "desktop",
      KLIPPEE_CONFIG_DIR: config,
      KLIPPEE_REPOSITORY_ID: repositoryId,
      KLIPPEE_TOKEN: token,
    };
    delete env.KLIPPEE_STATE_DIR;
    return env;
  }

  try {
    await mkdir(home, { recursive: true });
    await mkdir(firstConfig, { recursive: true });
    await mkdir(nestedSecondConfig, { recursive: true });
    await mkdir(join(firstConfig, ".klippee"), { recursive: true });
    await writeFile(join(firstConfig, ".klippee", ".gitignore"), "!config.json\n");
    const firstEnv = desktopEnvironment("repo_one", "klp_one", firstConfig);
    const secondEnv = desktopEnvironment("repo_two", "klp_two", secondConfig);

    const firstInit = await run(python, [installer, "init", "--desktop"], { cwd: firstConfig, env: firstEnv });
    assert.equal(firstInit.status, 0, firstInit.stderr || firstInit.stdout);
    const secondInit = await run(python, [installer, "init", "--desktop"], { cwd: secondConfig, env: secondEnv });
    assert.equal(secondInit.status, 0, secondInit.stderr || secondInit.stdout);

    const firstStored = JSON.parse(await readFile(join(firstConfig, ".klippee", "config.json"), "utf8"));
    const secondStored = JSON.parse(await readFile(join(secondConfig, ".klippee", "config.json"), "utf8"));
    assert.equal(firstStored.repository_id, "repo_one");
    assert.equal(secondStored.repository_id, "repo_two");
    assert.match((await readFile(join(firstConfig, ".klippee", ".gitignore"), "utf8")).replaceAll("\r\n", "\n"), /^!config\.json\n# Klippee local state.*\n\*\n$/);
    assert.match((await readFile(join(secondConfig, ".klippee", ".gitignore"), "utf8")).replaceAll("\r\n", "\n"), /^# Klippee local state.*\n\*\n$/);
    await assert.rejects(stat(join(home, ".klippee", "config.json")));

    const firstTarget = await run(python, [installer, "target"], { cwd: firstConfig, env: firstEnv });
    assert.equal(firstTarget.status, 0, firstTarget.stderr || firstTarget.stdout);
    assert.match(firstTarget.stdout, /Target: {2}repo_one \(printer_repo_one\)/);
    assert.match(firstTarget.stdout, /Applied: version 4 at 2026-08-05T10:00:00Z/);
    assert.match(firstTarget.stdout, /Desired: version 5 \(pending\) at 2026-08-06T10:00:00Z/);
    assert.match(firstTarget.stdout, /State: {3}pending configuration/);

    const secondTarget = await run(python, [installer, "target"], { cwd: nestedSecondConfig, env: firstEnv });
    assert.equal(secondTarget.status, 0, secondTarget.stderr || secondTarget.stdout);
    assert.match(secondTarget.stdout, /Target: {2}repo_two \(printer_repo_two\)/);
    assert.match(secondTarget.stdout, /Applied: version 7/);
    assert.match(secondTarget.stdout, /Desired: version 7/);
    assert.match(secondTarget.stdout, /State: {3}up to date/);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("applies noninteractively only from a valid clean sync baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-if-clean-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  let remoteVersion = 1;
  let pullRequests = 0;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/pull")) {
      pullRequests += 1;
      sendJson(response, 200, {
        printer: { variableValues: {} },
        version: {
          created_at: `2026-08-0${remoteVersion}T00:00:00Z`,
          files: [{
            content: `[printer]\nrevision = ${remoteVersion}\n`,
            path: "printer.cfg",
            public: false,
            role: "main",
          }],
          id: `version_${remoteVersion}`,
          revision: `sha256:version-${remoteVersion}`,
          source: "web-editor",
          version_number: remoteVersion,
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/status.txt")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`repository_id=repo_1\nprinter_id=printer_1\nprinter_name=Test printer\ntarget_version=${remoteVersion}\n`);
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/applied")) {
      await requestJson(request);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/host-info")) {
      await requestJson(request);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: `Unexpected request: ${request.method} ${url.pathname}` });
  });

  try {
    await mkdir(home, { recursive: true });
    const env = testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state });
    const init = await run(python, [installer, "init"], { env });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const missingBaseline = await run(python, [installer, "apply", "--if-clean"], { env });
    assert.notEqual(missingBaseline.status, 0);
    assert.match(missingBaseline.stderr, /requires an existing valid sync baseline/);
    assert.equal(pullRequests, 0, "missing-baseline refusal must happen before downloading a target");

    const initialApply = await run(python, [installer, "apply", "--yes"], { env });
    assert.equal(initialApply.status, 0, initialApply.stderr || initialApply.stdout);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /revision = 1/);

    remoteVersion = 2;
    const cleanApply = await run(python, [installer, "apply", "--if-clean"], { env });
    assert.equal(cleanApply.status, 0, cleanApply.stderr || cleanApply.stdout);
    assert.match(cleanApply.stdout, /update printer\.cfg/);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /revision = 2/);

    await writeFile(join(config, "printer.cfg"), "[printer]\nlocal = edited\n");
    remoteVersion = 3;
    const requestsBeforeDirtyApply = pullRequests;
    const dirtyApply = await run(python, [installer, "apply", "--if-clean"], { env });
    assert.notEqual(dirtyApply.status, 0);
    assert.match(dirtyApply.stderr, /refused because local configuration changed since the last sync/);
    assert.match(dirtyApply.stderr, /printer\.cfg/);
    assert.equal(pullRequests, requestsBeforeDirtyApply, "dirty refusal must happen before downloading a target");
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /local = edited/);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("installs a desktop workspace without updating physical printer state", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-desktop-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "ide-config");
  let appliedRequests = 0;
  let captureConflict = false;
  let hostInfoRequests = 0;
  let pushedPayload = null;
  let desktopPullHadNoVersionOverride = false;
  let desktopFiles = [
    { content: "[printer]\nkinematics: corexy\nname: ${KLIPPEE:desktop_name}\n", path: "printer.cfg", public: false, role: "main" },
    { content: "[gcode_macro RETIRED]\ngcode: M117 retired\n", path: "retired.cfg", public: false, role: "macro" },
  ];
  let desktopVersion = {
    created_at: "2026-08-03T01:00:00Z",
    id: "version_desktop_4",
    revision: "sha256:desktop-version-4",
    source: "web-editor",
    version_number: 4,
  };
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/pull")) {
      desktopPullHadNoVersionOverride = url.search === "";
      sendJson(response, 200, {
        printer: { variableValues: { desktop_name: "IDE profile" } },
        version: {
          ...desktopVersion,
          files: desktopFiles,
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/status.txt")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("repository_id=repo_1\nprinter_id=printer_1\nprinter_name=Desktop target\n");
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/applied")) {
      appliedRequests += 1;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/host-info")) {
      hostInfoRequests += 1;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      pushedPayload = await requestJson(request);
      if (captureConflict) {
        sendJson(response, 409, {
          code: "desired_configuration_conflict",
          error: "Desired configuration changed since this client synchronized",
        });
        return;
      }
      sendJson(response, 201, {
        version: {
          created_at: "2026-08-03T03:00:00Z",
          files: pushedPayload.files,
          id: "version_desktop_6",
          revision: "sha256:desktop-version-6",
          source: "capture",
          version_number: 6,
        },
      });
      return;
    }
    sendJson(response, 404, { error: `Unexpected request: ${request.method} ${url.pathname}` });
  });

  try {
    const env = {
      ...testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state }),
      KLIPPEE_CLIENT_MODE: "desktop",
      KLIPPEE_APPLY_CURRENT: "1",
    };
    delete env.KLIPPEE_CONFIG_DIR;
    await mkdir(config, { recursive: true });
    const install = await run(python, [installer, "install"], { cwd: config, env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stdout, /configured desktop workspace/);
    assert.match(install.stdout, /applying the desired configuration/);
    assert.match(install.stdout, /Updated: 2 configuration paths/);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /name: IDE profile/);
    assert.equal(desktopPullHadNoVersionOverride, true);
    assert.equal(appliedRequests, 0);
    assert.equal(hostInfoRequests, 0);
    const initialMetadata = await readFile(join(config, ".klippee", "last-sync"), "utf8");
    assert.match(initialMetadata, /^schema=1$/m);
    assert.match(initialMetadata, /^version=4$/m);
    assert.match(initialMetadata, /^version_id=version_desktop_4$/m);
    assert.match(initialMetadata, /^revision=sha256:desktop-version-4$/m);

    const cli = installedCli(prefix);
    const showTarget = await run(python, [cli, "target"], { env });
    assert.equal(showTarget.status, 0, showTarget.stderr || showTarget.stdout);
    assert.match(showTarget.stdout, /Role: {4}desktop workspace/);
    assert.match(showTarget.stdout, new RegExp(config.replaceAll("\\", "\\\\")));
    assert.doesNotMatch(showTarget.stdout, /klp_test/);

    desktopFiles = [desktopFiles[0]];
    desktopVersion = {
      created_at: "2026-08-03T02:00:00Z",
      id: "version_desktop_5",
      revision: "sha256:desktop-version-5",
      source: "web-editor",
      version_number: 5,
    };
    const refreshedApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.equal(refreshedApply.status, 0, refreshedApply.stderr || refreshedApply.stdout);
    await assert.rejects(stat(join(config, "retired.cfg")));

    await writeFile(join(config, "printer.cfg"), "[printer]\nkinematics: corexy\nmax_velocity: 300\n");
    const capture = await run(python, [cli, "capture", "--note", "Edited in IDE"], { env });
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);
    assert.match(capture.stdout, /Captured: 1 configuration file/);
    assert.match(JSON.stringify(pushedPayload.files), /max_velocity/);
    assert.equal(pushedPayload.clientMode, "desktop");
    assert.equal(pushedPayload.protocolVersion, 2);
    assert.equal(pushedPayload.baseVersionNumber, 5);
    assert.equal(pushedPayload.baseRevision, "sha256:desktop-version-5");
    const capturedMetadata = await readFile(join(config, ".klippee", "last-sync"), "utf8");
    assert.match(capturedMetadata, /^version=6$/m);
    assert.match(capturedMetadata, /^version_id=version_desktop_6$/m);
    assert.match(capturedMetadata, /^revision=sha256:desktop-version-6$/m);
    assert.match(capturedMetadata, /^source=capture$/m);
    assert.equal(hostInfoRequests, 0);

    const capturedManifest = await readFile(join(config, ".klippee", "last-sync-files"), "utf8");
    captureConflict = true;
    await writeFile(join(config, "printer.cfg"), "[printer]\nkinematics: corexy\nmax_velocity: 301\n");
    const conflict = await run(python, [cli, "capture"], { env });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /capture stopped; no cloud state or workspace baseline was changed/);
    assert.equal(pushedPayload.baseVersionNumber, 6);
    assert.equal(pushedPayload.baseRevision, "sha256:desktop-version-6");
    assert.equal(await readFile(join(config, ".klippee", "last-sync"), "utf8"), capturedMetadata);
    assert.equal(await readFile(join(config, ".klippee", "last-sync-files"), "utf8"), capturedManifest);

    desktopFiles = [
      { content: "[printer]\nkinematics: corexy\n", path: "printer.cfg", public: false, role: "main" },
      { content: "[printer]\nkinematics: cartesian\n", path: "Printer.cfg", public: false, role: "main" },
    ];
    desktopVersion = {
      created_at: "2026-08-03T04:00:00Z",
      id: "version_desktop_collision",
      revision: "sha256:desktop-collision",
      source: "web-editor",
      version_number: 7,
    };
    const collidingApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.notEqual(collidingApply.status, 0);
    assert.match(collidingApply.stderr, /colliding config paths: printer\.cfg and Printer\.cfg/);

    const timer = await run(python, [cli, "install-timer"], { env });
    assert.notEqual(timer.status, 0);
    assert.match(timer.stderr, /only available in printer mode/);
    await assert.rejects(stat(join(home, ".config", "systemd", "user", "klippee-sync.service")));
    await assert.rejects(stat(join(home, ".config", "systemd", "user", "klippee-sync.timer")));
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("lists and applies cloud recovery points", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-rollback-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  let latestNumber = 3;
  let latestFiles = [{ content: "[printer]\nmax_velocity: 300\n", path: "printer.cfg", public: false, role: "main" }];
  let rollbackTarget = null;
  const appliedVersions = [];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/versions")) {
      sendJson(response, 200, {
        versions: [
          { created_at: "2026-07-24T00:03:00Z", message: "Fast profile", source: "capture", version_number: 3 },
          { created_at: "2026-07-24T00:02:00Z", message: "Balanced profile", source: "web-editor", version_number: 2 },
          { created_at: "2026-07-24T00:01:00Z", message: "Initial import", source: "import", version_number: 1 },
        ],
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/pull")) {
      sendJson(response, 200, {
        printer: { variableValues: {} },
        version: { files: latestFiles, version_number: latestNumber },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/status.txt")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("repository_id=repo_1\nprinter_id=printer_1\nprinter_name=Recovery printer\n");
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/rollback")) {
      const payload = await requestJson(request);
      rollbackTarget = payload.versionNumber;
      latestNumber = 4;
      latestFiles = [{ content: "[printer]\nmax_velocity: 200\n", path: "printer.cfg", public: false, role: "main" }];
      sendJson(response, 201, {
        sourceVersionNumber: payload.versionNumber,
        version: { files: latestFiles, source: "recovery", version_number: latestNumber },
      });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/applied")) {
      const payload = await requestJson(request);
      appliedVersions.push(payload.versionNumber);
      sendJson(response, 200, { appliedVersion: { version_number: latestNumber }, ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/host-info")) {
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

    const recoveryPoints = await run(python, [cli, "recover"], { env });
    assert.equal(recoveryPoints.status, 0, recoveryPoints.stderr || recoveryPoints.stdout);
    assert.match(recoveryPoints.stdout, /cloud:3 \(desired\).*Fast profile/);
    assert.match(recoveryPoints.stdout, /cloud:1 .*Initial import/);

    const firstApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.equal(firstApply.status, 0, firstApply.stderr || firstApply.stdout);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /max_velocity: 300/);

    const recovery = await run(python, [cli, "recover", "cloud:1"], { env });
    assert.equal(recovery.status, 0, recovery.stderr || recovery.stdout);
    assert.equal(rollbackTarget, 1);
    assert.match(recovery.stdout, /Recovered cloud:1 as the desired configuration/);
    assert.match(recovery.stdout, /Recovery printer .* is current/);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /max_velocity: 200/);
    assert.deepEqual(appliedVersions, [3, 4]);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("lists the pending draft separately and can recover the latest immutable printer state", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-cancel-draft-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  const appliedFiles = [{ content: "[printer]\nmax_velocity: 300\n", path: "printer.cfg", public: false, role: "main" }];
  const draftFiles = [{ content: "[printer]\nmax_velocity: 500\n", path: "printer.cfg", public: false, role: "main" }];
  let pendingDraft = true;
  let rollbackTarget = null;
  const appliedVersions = [];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/versions")) {
      sendJson(response, 200, {
        versions: [
          { created_at: "2026-08-03T00:03:00Z", message: "Printer capture", source: "capture", version_number: 3 },
          { created_at: "2026-08-03T00:02:00Z", message: "Previous capture", source: "capture", version_number: 2 },
        ],
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/pull")) {
      sendJson(response, 200, {
        printer: { appliedVersionId: 3, variableValues: {} },
        version: pendingDraft
          ? { files: draftFiles, revision: "sha256:draft", source: "pending", version_number: 4 }
          : { files: appliedFiles, revision: "sha256:applied", source: "capture", version_number: 3 },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/status.txt")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("repository_id=repo_1\nprinter_id=printer_1\nprinter_name=Recovery printer\n");
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/rollback")) {
      const payload = await requestJson(request);
      rollbackTarget = payload.versionNumber;
      pendingDraft = false;
      sendJson(response, 200, {
        cancelledDraft: true,
        sourceVersionNumber: payload.versionNumber,
        version: { files: appliedFiles, revision: "sha256:applied", source: "capture", version_number: 3 },
      });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/applied")) {
      const payload = await requestJson(request);
      appliedVersions.push(payload.versionNumber);
      sendJson(response, 200, { appliedVersion: { version_number: 3 }, desiredChanged: false, ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/host-info")) {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: `Unexpected request: ${request.method} ${url.pathname}` });
  });

  try {
    await mkdir(home, { recursive: true });
    await mkdir(config, { recursive: true });
    const env = {
      ...testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state }),
      KLIPPEE_ALLOW_INSECURE_UPGRADE: "1",
      KLIPPEE_UPGRADE_BASE_URL: server.baseUrl,
    };
    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const cli = installedCli(prefix);

    const recoveryPoints = await run(python, [cli, "recover"], { env });
    assert.equal(recoveryPoints.status, 0, recoveryPoints.stderr || recoveryPoints.stdout);
    assert.match(recoveryPoints.stdout, /pending draft \(desired; choose a cloud recovery point to replace it\)/);
    assert.match(recoveryPoints.stdout, /cloud:3 \(applied, latest saved; selecting cancels draft\).*Printer capture/);

    const recovery = await run(python, [cli, "recover", "cloud:3"], { env });
    assert.equal(recovery.status, 0, recovery.stderr || recovery.stdout);
    assert.equal(rollbackTarget, 3);
    assert.match(recovery.stdout, /Recovered cloud:3 as the desired configuration/);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /max_velocity: 300/);
    assert.deepEqual(appliedVersions, [3]);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("records a sync baseline and refuses to overwrite changed config paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  let hostInfoCapture = null;
  const appliedReports = [];
  let pushCapture = null;
  let lastPushedFiles = null;
  let pushRequestCount = 0;

  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/pull")) {
      sendJson(response, 200, {
        printer: { variableValues: { cloud_name: "profile-value" } },
        version: {
          created_at: "2026-08-03T04:00:00Z",
          files: [{
            content: "[printer]\nremote = 2\ncloud = ${KLIPPEE:cloud_name}\nsecret = ${KLIPPEE:local_secret}\n",
            path: "printer.cfg",
            public: false,
            role: "main",
          }],
          id: "version_2",
          revision: "sha256:printer-version-2",
          source: "web-editor",
          version_number: 2,
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/status.txt")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("repository_id=repo_1\nprinter_id=printer_1\nprinter_name=Test printer\n");
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/applied")) {
      appliedReports.push(await requestJson(request));
      sendJson(response, 200, {
        appliedVersion: { revision: "sha256:printer-version-2", version_number: 2 },
        ok: true,
      });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/host-info")) {
      hostInfoCapture = await requestJson(request);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      pushRequestCount += 1;
      const payload = await requestJson(request);
      if (payload.message === "Server rejects") {
        sendJson(response, 400, { error: "Too many files: 65 exceeds the 64-file limit" });
        return;
      }
      pushCapture = payload;
      if (lastPushedFiles && JSON.stringify(lastPushedFiles) === JSON.stringify(payload.files)) {
        sendJson(response, 200, { unchanged: true, version: { files: payload.files, version_number: 3 } });
        return;
      }
      lastPushedFiles = payload.files;
      sendJson(response, 201, { version: { files: payload.files, version_number: 3 } });
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
    assert.match(install.stdout, /INSTALLATION SUCCESSFUL/);

    const cli = installedCli(prefix);
    const missingVariableApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.notEqual(missingVariableApply.status, 0);
    assert.match(missingVariableApply.stderr, /missing printer values for: local_secret/);
    assert.match(missingVariableApply.stderr, /klippee variables set <name> <value>/);

    const setLocalVariable = await run(python, [cli, "variables", "set", "local_secret", "host-secret"], { env });
    assert.equal(setLocalVariable.status, 0, setLocalVariable.stderr || setLocalVariable.stdout);
    const firstApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.equal(firstApply.status, 0, firstApply.stderr || firstApply.stdout);
    assert.match(firstApply.stdout, /Rendered printer values: cloud_name, local_secret/);
    const renderedConfig = await readFile(join(config, "printer.cfg"), "utf8");
    assert.match(renderedConfig, /cloud = profile-value/);
    assert.match(renderedConfig, /secret = host-secret/);
    assert.doesNotMatch(renderedConfig, /\$\{KLIPPEE:/);
    assert.deepEqual(appliedReports[0], {
      desiredRevision: "sha256:printer-version-2",
      files: [{
        content: "[printer]\nremote = 2\ncloud = ${KLIPPEE:cloud_name}\nsecret = ${KLIPPEE:local_secret}\n",
        path: "printer.cfg",
        public: false,
        role: "main",
      }],
      protocolVersion: 2,
      versionNumber: 2,
    });
    assert.doesNotMatch(JSON.stringify(appliedReports[0]), /host-secret/);

    const manifest = await readFile(join(config, ".klippee", "last-sync-files"), "utf8");
    assert.match(manifest, /\|printer\.cfg$/m);
    assert.ok(hostInfoCapture);
    assert.match(hostInfoCapture.hostInfo.cliVersion, /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/);
    assert.ok(hostInfoCapture.hostInfo.kernel);
    assert.ok(hostInfoCapture.hostInfo.arch);

    await writeFile(join(config, "printer.cfg"), "[include extra.cfg]\n[printer]\nlocal = changed\n");
    const blockedApply = await run(python, [cli, "apply"], { env });
    assert.notEqual(blockedApply.status, 0);
    assert.match(blockedApply.stderr, /apply requires confirmation/);
    assert.match(blockedApply.stdout, /update printer\.cfg/);

    const confirmedApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.equal(confirmedApply.status, 0, confirmedApply.stderr || confirmedApply.stdout);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /remote = 2/);
    const applyBackupPath = confirmedApply.stdout.match(/Backup:\s+(.+)/)?.[1]?.trim();
    assert.ok(applyBackupPath);
    assert.match(await readFile(join(applyBackupPath, "printer.cfg"), "utf8"), /local = changed/);

    await writeFile(join(config, "printer.cfg"), "[include extra.cfg]\n[printer]\nbroken = true\n");
    await writeFile(join(config, "extra.cfg"), "[extra]\nlocal = only\n");
    await mkdir(join(config, ".klippee", "backups", "old"), { recursive: true });
    await writeFile(join(config, ".klippee", "backups", "old", "stale.cfg"), "[stale]\nshould = stay-out\n");

    const recovery = await run(python, [cli, "recover", `local:${basename(applyBackupPath)}`], { env });
    assert.equal(recovery.status, 0, recovery.stderr || recovery.stdout);
    assert.match(recovery.stdout, /update printer\.cfg/);
    assert.match(recovery.stdout, /keep local-only extra\.cfg/);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /local = changed/);
    const backupPath = recovery.stdout.match(/Backup:\s+(.+)/)?.[1]?.trim();
    assert.ok(backupPath);
    assert.match(await readFile(join(backupPath, "printer.cfg"), "utf8"), /broken = true/);
    assert.match(await readFile(join(backupPath, "extra.cfg"), "utf8"), /local = only/);
    await assert.rejects(stat(join(backupPath, ".klippee", "backups", "old", "stale.cfg")));

    const check = await run(python, [cli, "check", "--diff"], { env });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.match(check.stdout, /Only local: extra\.cfg/);
    assert.doesNotMatch(check.stdout, /stale\.cfg/);

    await writeFile(join(config, "saved_variables.cfg"), "token: do-not-upload\n");
    await mkdir(join(config, "macros"), { recursive: true });
    await writeFile(join(config, "macros", "api_token.cfg"), "token: also-private\n");
    await writeFile(join(config, "macros", "unused_macro.cfg"), "[gcode_macro NEVER_LOADED]\ngcode:\n    M117 unused\n");
    await writeFile(join(config, "printer-20260101_000000.cfg"), "[old]\nsave_config = backup\n");
    const capture = await run(python, [cli, "capture", "--note", "Safe snapshot"], { env });
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);
    assert.match(capture.stdout, /Captured: 2 configuration files/);
    assert.doesNotMatch(capture.stdout, /local = only/);
    assert.doesNotMatch(capture.stdout, /"content"/);
    assert.match(capture.stderr, /skipped unreferenced, backup, or sensitive files/);
    assert.match(capture.stderr, / {2}- macros\/unused_macro\.cfg/);
    assert.ok(pushCapture);
    const capturedJson = JSON.stringify(pushCapture);
    assert.match(capturedJson, /printer\.cfg/);
    assert.match(capturedJson, /extra\.cfg/);
    assert.doesNotMatch(capturedJson, /saved_variables\.cfg/);
    assert.doesNotMatch(capturedJson, /api_token\.cfg/);
    assert.doesNotMatch(capturedJson, /unused_macro\.cfg/);
    assert.doesNotMatch(capturedJson, /printer-20260101_000000\.cfg/);

    const unchangedCapture = await run(python, [cli, "capture"], { env });
    assert.equal(unchangedCapture.status, 0, unchangedCapture.stderr || unchangedCapture.stdout);
    assert.match(unchangedCapture.stdout, /desired configuration was already identical/);
    assert.doesNotMatch(unchangedCapture.stdout, /"content"/);
    assert.equal(pushRequestCount, 2);

    await writeFile(join(config, "printer.cfg"), "[include extra.cfg]\n[printer]\nlocal = changed\n# verbose change\n");
    const notedCapture = await run(python, [cli, "capture", "--note", "Detailed capture"], { env });
    assert.equal(notedCapture.status, 0, notedCapture.stderr || notedCapture.stdout);
    assert.match(notedCapture.stdout, /Captured: 2 configuration files/);
    assert.doesNotMatch(notedCapture.stdout, /"content"/);
    assert.equal(pushRequestCount, 3);

    await writeFile(join(config, "printer.cfg"), "[include extra.cfg]\n[printer]\nlocal = changed again\n");
    const failedCapture = await run(python, [cli, "capture", "--note", "Server rejects"], { env });
    assert.notEqual(failedCapture.status, 0);
    assert.match(failedCapture.stderr, /server returned HTTP 400/);
    assert.match(failedCapture.stderr, /Too many files/);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("ignores generated Beacon models and bed meshes in config diffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-diff-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  const remoteConfig = `[printer]
max_velocity: 500

[bed_mesh]
speed: 200

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
#*# [input_shaper]
#*# shaper_type_x = mzv
#*# shaper_freq_x = 55.8
#*#
#*# [beacon model default]
#*# model_coef = 1.111,
#*#   2.222
#*# model_temp = 38.0
#*#
#*# [bed_mesh default]
#*# version = 1
#*# points =
#*#   0.100, 0.200
#*#   0.300, 0.400
#*# x_count = 2
#*# y_count = 2
`;
  const localConfig = `[printer]
max_velocity: 500

[bed_mesh]
speed: 200

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
#*# [input_shaper]
#*# shaper_type_x = mzv
#*# shaper_freq_x = 55.8
#*#
#*# [beacon model default]
#*# model_coef = 9.999,
#*#   8.888
#*# model_temp = 54.0
#*#
#*# [bed_mesh default]
#*# version = 1
#*# points =
#*#   -0.100, -0.200
#*#   -0.300, -0.400
#*# x_count = 2
#*# y_count = 2
#*#
#*# [bed_mesh kamp]
#*# version = 1
#*# points =
#*#   0.010, 0.020
#*#   0.030, 0.040
#*# x_count = 2
#*# y_count = 2
`;

  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/pull")) {
      sendJson(response, 200, {
        version: {
          files: [{ content: remoteConfig, path: "printer.cfg", public: false, role: "main" }],
          version_number: 4,
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/status.txt")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("repository_id=repo_1\nprinter_id=printer_1\nprinter_name=Calibration printer\n");
      return;
    }
    sendJson(response, 404, { error: `Unexpected request: ${request.method} ${url.pathname}` });
  });

  try {
    await mkdir(home, { recursive: true });
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "printer.cfg"), localConfig);
    const env = testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state });

    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const cli = installedCli(prefix);

    const calibrationOnly = await run(python, [cli, "check", "--diff"], { env });
    assert.equal(calibrationOnly.status, 0, calibrationOnly.stderr || calibrationOnly.stdout);
    assert.doesNotMatch(calibrationOnly.stdout, /desired\/printer\.cfg/);
    assert.doesNotMatch(calibrationOnly.stdout, /beacon model default/);
    assert.doesNotMatch(calibrationOnly.stdout, /bed_mesh default/);
    assert.doesNotMatch(calibrationOnly.stdout, /bed_mesh kamp/);
    assert.doesNotMatch(calibrationOnly.stdout, /model_coef|model_temp|points =/);

    await writeFile(
      join(config, "printer.cfg"),
      localConfig.replace("max_velocity: 500", "max_velocity: 510").replace("speed: 200", "speed: 210"),
    );
    const meaningfulChange = await run(python, [cli, "check", "--diff"], { env });
    assert.equal(meaningfulChange.status, 0, meaningfulChange.stderr || meaningfulChange.stdout);
    assert.match(meaningfulChange.stdout, /^-max_velocity: 500$/m);
    assert.match(meaningfulChange.stdout, /^\+max_velocity: 510$/m);
    assert.match(meaningfulChange.stdout, /^-speed: 200$/m);
    assert.match(meaningfulChange.stdout, /^\+speed: 210$/m);
    assert.doesNotMatch(meaningfulChange.stdout, /beacon model default/);
    assert.doesNotMatch(meaningfulChange.stdout, /bed_mesh default/);
    assert.doesNotMatch(meaningfulChange.stdout, /bed_mesh kamp/);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("only syncs files reachable from the printer.cfg include graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-includes-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  let pushCapture = null;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      pushCapture = await requestJson(request);
      sendJson(response, 201, { version: { version_number: 1 } });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/host-info")) {
      await requestJson(request);
      sendJson(response, 500, { error: "Host metadata unavailable" });
      return;
    }
    sendJson(response, 404, { error: "Unexpected request" });
  });

  try {
    await mkdir(home, { recursive: true });
    await mkdir(join(config, "macros"), { recursive: true });
    await mkdir(join(config, "sub"), { recursive: true });
    const kampSource = join(root, "Klipper-Adaptive-Meshing-Purging", "Configuration");
    await mkdir(kampSource, { recursive: true });
    await symlink(kampSource, join(config, "KAMP"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(
      join(config, "printer.cfg"),
      "[include macros/*.cfg]\n[include sub/base.cfg]\n[include KAMP_Settings.cfg]\n[printer]\nkinematics: corexy\n",
    );
    await writeFile(join(config, "macros", "one.cfg"), "[gcode_macro ONE]\ngcode:\n    M117 one\n");
    await writeFile(join(config, "macros", "two.cfg"), "[gcode_macro TWO]\ngcode:\n    M117 two\n");
    await writeFile(join(config, "sub", "base.cfg"), "[include inner.cfg]\n");
    await writeFile(join(config, "sub", "inner.cfg"), "[stepper_x]\n");
    await writeFile(
      join(config, "KAMP_Settings.cfg"),
      [
        "[include ./KAMP/Adaptive_Meshing.cfg]",
        "[include ./KAMP/Line_Purge.cfg]",
        "[include ./KAMP/Voron_Purge.cfg]",
        "[include ./KAMP/Smart_Park.cfg]",
        "",
      ].join("\n"),
    );
    for (const name of ["Adaptive_Meshing.cfg", "Line_Purge.cfg", "Voron_Purge.cfg", "Smart_Park.cfg"]) {
      await writeFile(join(kampSource, name), `[gcode_macro ${name.replace(".cfg", "").toUpperCase()}]\n`);
    }
    await writeFile(join(config, "orphan.cfg"), "[gcode_macro ORPHAN]\ngcode:\n    M117 orphan\n");
    const env = testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state });
    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const capture = await run(python, [installedCli(prefix), "capture", "--note", "Reachable only"], { env });
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);
    assert.match(capture.stderr, / {2}- orphan\.cfg/);
    assert.match(capture.stderr, /warning: could not report host info/);
    assert.match(capture.stderr, /server returned HTTP 500/);
    assert.match(capture.stderr, /Host metadata unavailable/);
    const pushedJson = JSON.stringify(pushCapture);
    for (const path of [
      "printer.cfg",
      "macros/one.cfg",
      "macros/two.cfg",
      "sub/base.cfg",
      "sub/inner.cfg",
      "KAMP_Settings.cfg",
      "KAMP/Adaptive_Meshing.cfg",
      "KAMP/Line_Purge.cfg",
      "KAMP/Voron_Purge.cfg",
      "KAMP/Smart_Park.cfg",
    ]) {
      assert.match(pushedJson, new RegExp(path.replaceAll("/", "\\/")));
    }
    assert.doesNotMatch(pushedJson, /orphan\.cfg/);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("filters sensitive targets hidden behind linked include aliases", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-sensitive-link-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer_data", "config");
  const external = join(root, "Klipper-Adaptive-Meshing-Purging", "Configuration");
  let pushedFiles = [];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      const payload = await requestJson(request);
      pushedFiles = payload.files;
      sendJson(response, 201, { version: { id: "version_1", revision: "revision_1", version_number: 1 } });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/host-info")) {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: "Unexpected request" });
  });

  try {
    await mkdir(home, { recursive: true });
    await mkdir(config, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(
      join(config, "printer.cfg"),
      "[include KAMP/Adaptive_Meshing.cfg]\n[include KAMP/params.cfg]\n[include KAMP/creds.cfg]\n[include KAMP/old.cfg]\n[include KAMP/private.cfg]\n[include KAMP/hidden.cfg]\n",
    );
    await writeFile(join(external, "Adaptive_Meshing.cfg"), "[gcode_macro ADAPTIVE_MESHING]\n");
    await writeFile(join(external, "secrets.cfg"), "[moonraker]\ntoken: FAKE_NOT_A_REAL_SECRET_12345\n");
    await writeFile(join(external, "passwords.cfg"), "[auth]\npassword: FAKE_NOT_A_REAL_PASSWORD_67890\n");
    await writeFile(join(external, "printer-123_456.cfg"), "# SAVE_CONFIG backup\n");
    await mkdir(join(external, ".private"), { recursive: true });
    await writeFile(join(external, ".private", "ordinary.cfg"), "[gcode_macro PRIVATE]\n");
    await writeFile(join(external, ".hidden.cfg"), "[gcode_macro HIDDEN]\n");
    await symlink(join(external, "secrets.cfg"), join(external, "redirect.cfg"));
    await symlink(join(external, "passwords.cfg"), join(external, "route.cfg"));
    await symlink(relative(config, external), join(config, "KAMP"), "dir");
    await symlink("redirect.cfg", join(config, "KAMP", "params.cfg"));
    await symlink("route.cfg", join(config, "KAMP", "creds.cfg"));
    await symlink("printer-123_456.cfg", join(config, "KAMP", "old.cfg"));
    await symlink(join(".private", "ordinary.cfg"), join(config, "KAMP", "private.cfg"));
    await symlink(".hidden.cfg", join(config, "KAMP", "hidden.cfg"));

    const env = testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state });
    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const capture = await run(python, [installedCli(prefix), "capture", "--note", "Linked config safety"], { env });
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);

    assert.ok(
      pushedFiles.some((file) => file.path === "KAMP/Adaptive_Meshing.cfg"),
      "ordinary external KAMP config should remain capturable",
    );
    assert.ok(
      !pushedFiles.some((file) => [
        "KAMP/params.cfg",
        "KAMP/creds.cfg",
        "KAMP/old.cfg",
        "KAMP/private.cfg",
        "KAMP/hidden.cfg",
      ].includes(file.path)),
      "aliases to sensitive, backup, and hidden targets should be excluded",
    );
    assert.doesNotMatch(JSON.stringify(pushedFiles), /FAKE_NOT_A_REAL_(?:SECRET|PASSWORD)/);
    for (const alias of ["params.cfg", "creds.cfg", "old.cfg", "private.cfg", "hidden.cfg"]) {
      assert.match(capture.stderr, new RegExp(`KAMP/${alias.replaceAll(".", "\\.")}`));
    }
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});

it("keeps linked includes capture-only during apply and local recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "klippee-cli-linked-write-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const config = join(root, "printer-config");
  const kampSource = join(root, "Klipper-Adaptive-Meshing-Purging", "Configuration");
  let revision = "sha256:linked-safe";
  let desiredPrinter = "[include KAMP/Adaptive_Meshing.cfg]\n[printer]\nstate = first\n";
  let desiredKamp = "[gcode_macro ADAPTIVE_MESHING]\ngcode:\n    M117 stable\n";
  let appliedReports = 0;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname.endsWith("/status.txt")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("repository_id=repo_1\nprinter_id=printer_1\nprinter_name=Linked test\n");
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/pull")) {
      sendJson(response, 200, {
        printer: { appliedVersionId: 0 },
        version: {
          created_at: "2026-08-04T00:00:00Z",
          files: [
            { content: desiredPrinter, path: "printer.cfg", public: false, role: "main" },
            { content: desiredKamp, path: "KAMP/Adaptive_Meshing.cfg", public: false, role: "include" },
          ],
          id: `pending:${revision}`,
          revision,
          source: "pending",
          version_number: revision.endsWith("unsafe") ? 2 : 1,
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/applied")) {
      await requestJson(request);
      appliedReports += 1;
      sendJson(response, 200, { desiredChanged: false });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/host-info")) {
      await requestJson(request);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: "Unexpected request" });
  });

  try {
    await mkdir(home, { recursive: true });
    await mkdir(config, { recursive: true });
    await mkdir(kampSource, { recursive: true });
    await symlink(kampSource, join(config, "KAMP"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(
      join(config, "printer.cfg"),
      "[include KAMP/Adaptive_Meshing.cfg]\n[printer]\nstate = local\n",
    );
    const stableKamp = "[gcode_macro ADAPTIVE_MESHING]\ngcode:\n    M117 stable\n";
    await writeFile(join(kampSource, "Adaptive_Meshing.cfg"), stableKamp);
    const env = testEnvironment({ baseUrl: server.baseUrl, config, home, prefix, state });
    const install = await run(python, [installer, "install"], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const cli = installedCli(prefix);

    const safeApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.equal(safeApply.status, 0, safeApply.stderr || safeApply.stdout);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /state = first/);
    assert.equal(await readFile(join(kampSource, "Adaptive_Meshing.cfg"), "utf8"), stableKamp);
    assert.equal(appliedReports, 1);

    revision = "sha256:linked-unsafe";
    desiredPrinter = "[include KAMP/Adaptive_Meshing.cfg]\n[printer]\nstate = second\n";
    desiredKamp = "[gcode_macro ADAPTIVE_MESHING]\ngcode:\n    M117 attacker-change\n";
    const blockedApply = await run(python, [cli, "apply", "--yes"], { env });
    assert.notEqual(blockedApply.status, 0);
    assert.match(blockedApply.stderr, /refusing to modify linked config outside/);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /state = first/);
    assert.equal(await readFile(join(kampSource, "Adaptive_Meshing.cfg"), "utf8"), stableKamp);
    assert.equal(appliedReports, 1);

    const unsafeRecovery = join(config, ".klippee", "backups", "unsafe-linked");
    await mkdir(join(unsafeRecovery, "KAMP"), { recursive: true });
    await writeFile(join(unsafeRecovery, "printer.cfg"), "[printer]\nstate = recovered\n");
    await writeFile(join(unsafeRecovery, "KAMP", "Adaptive_Meshing.cfg"), desiredKamp);
    const blockedRecovery = await run(python, [cli, "recover", "local:unsafe-linked"], { env });
    assert.notEqual(blockedRecovery.status, 0);
    assert.match(blockedRecovery.stderr, /refusing to modify linked config outside/);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /state = first/);
    assert.equal(await readFile(join(kampSource, "Adaptive_Meshing.cfg"), "utf8"), stableKamp);

    const externalRecovery = join(root, "external-recovery");
    await mkdir(externalRecovery, { recursive: true });
    await writeFile(join(externalRecovery, "printer.cfg"), "[printer]\nstate = external\n");
    await symlink(
      externalRecovery,
      join(config, ".klippee", "backups", "linked-root"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const linkedRootRecovery = await run(python, [cli, "recover", "local:linked-root"], { env });
    assert.notEqual(linkedRootRecovery.status, 0);
    assert.match(linkedRootRecovery.stderr, /refusing to restore linked recovery point/);
    assert.match(await readFile(join(config, "printer.cfg"), "utf8"), /state = first/);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});
