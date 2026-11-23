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

Download `compose.yaml`, `default.env.example`, `klippee-app-linux-amd64.tar.gz`,
`klippee-cad-linux-amd64.tar.gz` and `SHA256SUMS` from the same `selfhost-v*`
[GitHub release](https://github.com/cl-tim/klippee-web/releases) into an empty
directory.

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
sha256sum --check --ignore-missing SHA256SUMS
docker image load --input klippee-app-linux-amd64.tar.gz
docker image load --input klippee-cad-linux-amd64.tar.gz
docker compose up -d --no-build --pull never
docker compose ps
docker compose logs --tail 100 app
```

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
docker compose build --pull
docker compose up -d --no-build --pull never
```

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
both the Compose file and `KLIPPEE_VERSION` together. Download the new image
archives and checksum file from that release, then load both images:

```sh
sha256sum --check --ignore-missing SHA256SUMS
docker image load --input klippee-app-linux-amd64.tar.gz
docker image load --input klippee-cad-linux-amd64.tar.gz
docker compose up -d --no-build --pull never
```

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
