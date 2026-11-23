import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { prepareRelease, releaseImages, verifyPublicImages } from "../../scripts/self-host-release.mjs";

test("release tags produce matching GHCR images and reject unsafe input", () => {
  const release = releaseImages("selfhost-v1.2.3-rc.1", "ExampleOwner/klippee-web");
  assert.equal(release.app, "ghcr.io/exampleowner/klippee:selfhost-v1.2.3-rc.1");
  assert.equal(release.cad, "ghcr.io/exampleowner/klippee-cad:selfhost-v1.2.3-rc.1");
  for (const tag of [undefined, "latest", "v1.2.3", "selfhost-v1.2", "selfhost-v1.2.3;echo unsafe", "selfhost-v1.2.3/path", `selfhost-v1.2.3-${"a".repeat(128)}`]) {
    assert.throws(() => releaseImages(tag));
  }
  assert.throws(() => releaseImages("selfhost-v1.2.3", "owner/repo\napp=other-image"));
});

test("release assets pin the same version and repository, including prereleases", async () => {
  await mkdir(resolve("output"), { recursive: true });
  const directory = await mkdtemp(resolve("output/ghcr-release-test-"));
  try {
    const release = releaseImages("selfhost-v1.2.3-rc.2", "example/klippee-web");
    const destination = resolve(directory, "release");
    await prepareRelease(release, destination);
    const compose = parse(await readFile(resolve(destination, "compose.yaml"), "utf8"));
    const env = await readFile(resolve(destination, "default.env.example"), "utf8");
    for (const [service, image] of [["app", "klippee"], ["cad", "klippee-cad"]]) {
      assert.equal(compose.services[service].image, `\${${service === "app" ? "KLIPPEE_IMAGE" : "KLIPPEE_CAD_IMAGE"}:-ghcr.io/example/${image}}:\${KLIPPEE_VERSION:-selfhost-v1.2.3-rc.2}`);
      assert.equal(compose.services[service].build, undefined);
      assert.equal(compose.services[service].pull_policy, "missing");
    }
    assert.match(env, /^KLIPPEE_VERSION=selfhost-v1\.2\.3-rc\.2$/m);
    const guide = await readFile(resolve(destination, "SELF-HOSTING.md"), "utf8");
    assert.ok(guide.includes("https://github.com/example/klippee-web/blob/selfhost-v1.2.3-rc.2/server/CAD_NOTICE.md"));
    assert.ok(guide.includes("https://github.com/example/klippee-web/blob/selfhost-v1.2.3-rc.2/docs/operations/r2-reclamation.md"));
    assert.ok(guide.includes("`selfhost-v0.1.3`"), "Retain the historical archive-only instructions");
    assert.equal(await readFile(resolve(destination, "LICENSE"), "utf8"), await readFile("LICENSE", "utf8"));
    assert.equal(await readFile(resolve(destination, "NOTICE.md"), "utf8"), await readFile("NOTICE.md", "utf8"));
    await assert.rejects(prepareRelease(release, destination), /EEXIST/);

    // Also render when the template itself already has a prerelease default.
    await writeFile(resolve(directory, "compose.example.yaml"), "image: ghcr.io/cl-tim/klippee:selfhost-v1.2.3-rc.1\n");
    await writeFile(resolve(directory, ".env.example"), "KLIPPEE_VERSION=selfhost-v1.2.3-rc.1\n");
    await mkdir(resolve(directory, "docs/operations"), { recursive: true });
    await writeFile(resolve(directory, "docs/operations/self-hosting.md"), "Guide\n");
    for (const name of ["LICENSE", "NOTICE.md"]) await writeFile(resolve(directory, name), name);
    await prepareRelease(release, resolve(directory, "prerelease"), directory);
    assert.equal(await readFile(resolve(directory, "prerelease/default.env.example"), "utf8"), "KLIPPEE_VERSION=selfhost-v1.2.3-rc.2\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public access checks isolate publisher credentials and clean up on success and failure", async () => {
  const release = releaseImages("selfhost-v1.2.3");
  const images = [release.app, release.cad];
  for (const failCad of [false, true]) {
    const checked = [];
    let configuration;
    const check = verifyPublicImages(images, (command, args, options) => {
      assert.equal(command, "docker");
      configuration = args[1];
      assert.equal(args[0], "--config");
      assert.equal(options.env.DOCKER_CONFIG, configuration);
      assert.deepEqual(JSON.parse(readFileSync(resolve(configuration, "config.json"), "utf8")), { auths: {} });
      assert.deepEqual(args.slice(2, 4), ["manifest", "inspect"]);
      checked.push(args[4]);
      if (failCad && args[4] === release.cad) throw new Error("unauthorized");
    });
    if (failCad) await assert.rejects(check, /Cannot access .*klippee-cad.*anonymously.*Public/);
    else await check;
    assert.deepEqual(checked, images);
    assert.equal(existsSync(configuration), false);
  }
});

test("release workflow gates sequential pushes and public release on verified images", async () => {
  const workflow = parse(await readFile(".github/workflows/self-hosted-release.yml", "utf8"));
  assert.deepEqual(workflow.on.push.tags, ["selfhost-v*"]);
  assert.equal(workflow.concurrency.group, "self-hosted-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.publish.needs, "verify");
  assert.equal(workflow.permissions.packages, undefined);
  assert.equal(workflow.jobs.publish.permissions.packages, "write");
  const steps = workflow.jobs.publish.steps;
  const builds = steps.filter((step) => step.uses?.startsWith("docker/build-push-action@"));
  assert.equal(builds.length, 2);
  for (const build of builds) {
    assert.equal(build.with.load, true);
    assert.equal(build.with.push, undefined, "Never publish before the Compose smoke test");
    assert.equal(build.with.platforms, "linux/amd64");
    assert.match(build.with.labels, /org\.opencontainers\.image\.source=/);
    assert.match(build.with.labels, /org\.opencontainers\.image\.revision=/);
  }
  const index = (pattern) => steps.findIndex((step) => pattern.test(step.run ?? ""));
  const smoke = index(/self-host-container-smoke\.mjs/);
  const push = index(/docker push/);
  const anonymous = index(/self-host-release\.mjs verify-public/);
  const publish = index(/gh release create/);
  assert.ok(smoke > steps.indexOf(builds[1]) && push > smoke && anonymous > push && publish > anonymous);
  assert.equal(steps[push].run.trim(), 'docker push "$APP_IMAGE"\ndocker push "$CAD_IMAGE"');
  assert.equal(steps.find((step) => step.uses?.startsWith("docker/login-action@"))?.with.password, "${{ secrets.GITHUB_TOKEN }}");
  const compose = parse(await readFile("compose.yaml", "utf8"));
  const build = parse(await readFile("compose.build.yaml", "utf8"));
  for (const service of ["app", "cad"]) {
    assert.equal(compose.services[service].extends.file, "compose.example.yaml");
    assert.equal(compose.services[service].build, undefined);
    assert.ok(build.services[service].build);
    assert.equal(build.services[service].pull_policy, "never");
    assert.ok(!build.services[service].image.startsWith("ghcr.io/"));
  }
});
