import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseImages(tag, repository = "cl-tim/klippee-web") {
  if (!/^selfhost-v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag) || tag.length > 128) {
    throw new Error("Release tag must be selfhost-v<major>.<minor>.<patch> with an optional prerelease suffix");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9._-]+$/.test(repository)) {
    throw new Error("Release repository must be <owner>/<repository>");
  }
  const owner = repository.split("/")[0].toLowerCase();
  return { tag, repository, owner, app: `ghcr.io/${owner}/klippee:${tag}`, cad: `ghcr.io/${owner}/klippee-cad:${tag}` };
}

export async function prepareRelease(release, destination = "release", source = ".") {
  const read = (path) => readFile(resolve(source, path), "utf8");
  const versioned = (text) => text
    .replace(/selfhost-v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?/g, release.tag)
    .replaceAll("ghcr.io/cl-tim/", `ghcr.io/${release.owner}/`);
  const guide = (await read("docs/operations/self-hosting.md"))
    .replaceAll("https://github.com/cl-tim/klippee-web/blob/main/", `https://github.com/${release.repository}/blob/${release.tag}/`)
    .replaceAll("(r2-reclamation.md)", `(https://github.com/${release.repository}/blob/${release.tag}/docs/operations/r2-reclamation.md)`);
  // Refuse an existing destination rather than mixing two releases' assets.
  await mkdir(destination);
  const files = {
    "compose.yaml": versioned(await read("compose.example.yaml")),
    "default.env.example": versioned(await read(".env.example")),
    "SELF-HOSTING.md": guide,
    LICENSE: await read("LICENSE"),
    "NOTICE.md": await read("NOTICE.md"),
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(destination, name), contents);
  }
}

export async function verifyPublicImages(images, runDocker = execFileSync) {
  const directory = await mkdtemp(join(tmpdir(), "klippee-ghcr-anonymous-"));
  try {
    await writeFile(join(directory, "config.json"), JSON.stringify({ auths: {} }), { mode: 0o600 });
    for (const image of images) {
      try {
        runDocker("docker", ["--config", directory, "manifest", "inspect", image], {
          env: { ...process.env, DOCKER_CONFIG: directory },
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 60_000,
        });
      } catch (cause) {
        throw new Error(`Cannot access ${image} anonymously. Set both GHCR packages to Public in their package settings, then rerun the failed publish job.`, { cause });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = releaseImages(process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME, process.env.GITHUB_REPOSITORY);
  switch (process.argv[2]) {
    case "metadata":
      console.log(`app=${release.app}\ncad=${release.cad}`);
      break;
    case "prepare":
      await prepareRelease(release);
      break;
    case "verify-public":
      await verifyPublicImages([release.app, release.cad]);
      break;
    default:
      throw new Error("Usage: node scripts/self-host-release.mjs <metadata|prepare|verify-public>");
  }
}
