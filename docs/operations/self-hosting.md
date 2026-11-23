# Self-hosting Klippee

Run Klippee on a Linux AMD64 server with Docker Engine and Compose v2. No
Cloudflare account, API token, D1 database, R2 bucket, or Cloudflare Container
subscription is required. Allow at least 6 GB RAM for the two services and space
for your configuration history and diagnostics. ARM images are not provided:
the pinned OpenSCAD AppImage is x86_64.

This self-hosted release is experimental and supports one app instance
and one CAD instance on one server. It runs the existing Worker in the open
source workerd runtime using pinned Miniflare, with SQLite and blob files on a
local Docker volume. Miniflare is upstream development/testing software; this
is not Cloudflare's managed production platform. Do not scale app replicas or
share the data volume between running instances. Validate backups before
using the release for irreplaceable configurations.

## Install

Download `compose.yaml`, `default.env.example` and `SHA256SUMS` from the same `selfhost-v*`
[GitHub release](https://github.com/cl-tim/klippee-web/releases) into an empty
directory. The app and CAD images are pulled from GitHub Container Registry
(GHCR); no GitHub login, compiler or source checkout is needed.

Registry installation starts with `selfhost-v0.1.4` when that release is
published. `selfhost-v0.1.3` provides image archives only; use its own Compose
file and the [offline installation](#offline-installation) steps.

```sh
cp default.env.example .env
openssl rand -hex 32
```

Edit `.env`:

- Set `APP_ORIGIN` to your instance's HTTPS origin (no path).
- Set `SESSION_SECRET` to the generated value. Keep it across upgrades to
  preserve your printer sync tokens as well as any sign-in sessions.
- Keep `AUTH_MODE=local` for a private server. Everyone who can reach the
  instance can use and change the same workspace. Limit access to your trusted
  network or VPN, or enforce access at the reverse proxy.
- Set `KLIPPEE_VERSION` to the exact release tag you downloaded.

For per-user accounts, set `AUTH_MODE=oauth` and supply your own GitHub or
Discord application ID and secret. Register your provider's callback URL:

```text
https://klippee.example.com/api/auth/github/callback
https://klippee.example.com/api/auth/discord/callback
```

Then start the services:

```sh
grep -E '  (compose\.yaml|default\.env\.example)$' SHA256SUMS | sha256sum --check
docker compose --parallel 1 pull
docker compose up -d --no-build
docker compose ps
docker compose logs --tail 100 app
```

Both images use the same exact release tag:

- `ghcr.io/cl-tim/klippee:selfhost-v<version>`
- `ghcr.io/cl-tim/klippee-cad:selfhost-v<version>`

The supplied Compose file pins a version rather than `latest` and has no build
instructions. Keep `KLIPPEE_VERSION` on a published release. A missing tag or
an access error stops installation instead of starting a local build.

### Offline installation

On a connected machine, also download `klippee-app-linux-amd64.tar.gz` and
`klippee-cad-linux-amd64.tar.gz` from the same release. Transfer the release
files to the server, configure `.env` as above, then run:

```sh
sha256sum --check --ignore-missing SHA256SUMS
docker image load --input klippee-app-linux-amd64.tar.gz
docker image load --input klippee-cad-linux-amd64.tar.gz
docker compose up -d --no-build --pull never
```

New archives retain the GHCR image names and tags. For an older archive-only
release, keep its bundled Compose file, which uses the original local image
names. To use those older archives with a newer Compose file, set
`KLIPPEE_IMAGE=klippee`, `KLIPPEE_CAD_IMAGE=klippee-cad` and the matching
`KLIPPEE_VERSION` in `.env`.

The app applies pending migrations transactionally before listening. Existing
data survives container recreation. Local mode opens a single empty workspace
on first use. Existing installations that omit `AUTH_MODE` retain OAuth.
Switching modes changes which workspace you see. OAuth accounts and their data
stay in the volume and are accessible again when you return to OAuth mode.
Your instance's shared catalog starts empty and is independent of klippee.xyz.
The optional improvement-review and storage-maintenance APIs remain disabled
unless you supply their separate operator secrets.

## HTTPS reverse proxy

The app listens on host loopback port 8080 by default. Configure a host reverse
proxy to terminate HTTPS and forward to `127.0.0.1:8080`. For example, Caddy:

```caddyfile
klippee.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Preserve the original `Host` header so it matches `APP_ORIGIN`. Use HTTPS to
protect printer credentials and browser sessions in transit. Forward `Origin`
and `Cookie` headers unchanged. Configure
your proxy's upload limit for at least 64 MiB and its timeout for CAD jobs
(at least 180 seconds). If your proxy runs in Docker, connect it to the app's
network and proxy to `app:8080`; do not expose the CAD service or runtime
inspector. Configure the network in a Compose override appropriate to your
proxy. No Docker socket is mounted in either service.

Per-account and per-printer upload limits work normally. Anonymous rate limits
use the transport peer, so visitors behind one reverse proxy share that proxy's
limits. Add per-client rate limits at your HTTPS proxy when serving many users.
Caller-supplied Cloudflare and forwarded-IP headers are not trusted.

Check storage and CAD health through the app:

```sh
curl --fail https://klippee.example.com/api/health
curl --fail https://klippee.example.com/api/cad/health
```

Link printers and OrcaSlicer to **your instance's URL**. Generated setup commands
use that origin. Both authentication modes use scoped tokens for printer and
OrcaSlicer connections. URL imports contact their source and installing hlab
downloads its public release. The legacy Python printer client is also served
at `/install/klippee.py`.

## Build from source

Use a clean checkout of a release tag, copy `.env.example` to `.env`, configure
it as above, then run:

```sh
docker compose -f compose.yaml -f compose.build.yaml build --pull app
docker compose -f compose.yaml -f compose.build.yaml build --pull cad
docker compose -f compose.yaml -f compose.build.yaml up -d --no-build --pull never
```

Use both `-f` options for subsequent Compose commands on this installation.
The build override names the images `klippee-local:build` and
`klippee-cad-local:build`, keeping local builds separate from release tags.

The Docker build uses explicit source paths, never copies `.env`, `.dev.vars`,
local printer captures, or Git history, and installs npm dependencies with the
lockfile. CAD engines and model libraries are pinned in `Dockerfile.cad`.
The application image contains only compiled frontend/Worker output, runtime
dependencies, migrations, the standalone runner, and license notices. It does
not contain the generated Cloudflare deployment config or `.dev.vars`.

## Backup, upgrade and restore

Stop both services and back up the **entire** named data volume, plus `.env`
stored separately as a secret. For a default Compose project named `klippee`:

```sh
docker compose stop
docker run --rm -v klippee_klippee-data:/data:ro -v "$PWD:/backup" alpine:3.22 tar czf /backup/klippee-backup.tar.gz -C /data .
docker compose start
```

Use `docker volume ls` to confirm the actual volume name (Compose prefixes it
with your project/directory name). Keep the archive private: it contains user
data, printer details, credentials and diagnostics. To restore, stop the app,
restore the archive into an empty data volume, restore the matching `.env`, and
start the matching release. Never copy live SQLite files for a backup.

Before upgrading, make and verify a backup, read the release notes, and update
both the Compose file and `KLIPPEE_VERSION` together. Download the new Compose
file, environment template and checksum file from that release. Keep your
configured `.env`, merge any new settings from `default.env.example`, and retain
your `SESSION_SECRET`.

When switching from archive-only local images to GHCR, remove local
`KLIPPEE_IMAGE` and `KLIPPEE_CAD_IMAGE` overrides from `.env` so the GHCR defaults
apply. Verify the new installation files, then pull both images:

```sh
grep -E '  (compose\.yaml|default\.env\.example)$' SHA256SUMS | sha256sum --check
docker compose --parallel 1 pull
docker compose up -d --no-build
```

For an offline upgrade, use the matching image archives and the offline
installation steps instead. Keep the same Compose project/directory name so
the installation continues to use its existing data volume.

Migrations run once on startup. A downgrade may require restoring the old
volume backup as well as the old image tag; older code may not understand the
new schema. `docker compose down` keeps the volume; `down -v` deletes it.
Maintenance for expired sessions, diagnostics and temporary artifacts runs at
startup and hourly. Canonical blob reclamation remains an explicit operator
operation, as described in [R2 reclamation](r2-reclamation.md); its remote
inventory helper is for the hosted Cloudflare service, not this local volume.

Klippee is GPL-2.0-or-later. Bundled models have their own licenses and some
include noncommercial terms. See [notices](https://github.com/cl-tim/klippee-web/blob/main/NOTICE.md) and
[CAD runtime notices](https://github.com/cl-tim/klippee-web/blob/main/server/CAD_NOTICE.md) before redistributing images.

## Publishing a release

Maintainers publish releases by pushing a reviewed `selfhost-v<version>` tag
after the publication check and `npm run check` pass. The workflow runs its
checks sequentially, builds the app and CAD images in sequence, and tests the
pair through Compose before pushing those same images. It authenticates with
the repository's `GITHUB_TOKEN` and `packages: write`; no separate registry
secret is needed. Both packages carry the source repository and revision labels.

GitHub makes newly created packages private by default. On the first release:

1. Wait for both images to be pushed. The anonymous-access check will stop
   the job if either package is private.
2. Open [your packages](https://github.com/cl-tim?tab=packages), then open
   `klippee` and `klippee-cad`. In each package's **Package settings**, change
   **Visibility** to **Public** and ensure `cl-tim/klippee-web` has Actions access.
3. Rerun the failed publish job. The workflow checks both manifests with a
   temporary, empty Docker credential configuration before publishing the
   GitHub release and its offline archives.

See GitHub's [container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
for package visibility and repository access settings. Users can pull public
images without authentication. Keep the app and CAD release tags together;
there is no automatically updated `latest` tag.
