# klippee

If you like this project, you can [support me here](https://ko-fi.com/tquinn)

Klippee stores, syncs, and shares Klipper printer configurations. It includes:

- Public config packages that people can browse, compare, fork, and reuse. A
  linked printer workspace serves the applied configuration its owner most
  recently reviewed and published. Later printer applies remain private until
  the owner explicitly reviews their exact files and republishes them.
- Private printer workspaces with a mutable draft for editing and a separate
  last-applied configuration established only by an explicit physical-printer
  `apply` or `capture`.
- Browser-based config editing with reviewable changes, recovery history, and
  target-aware printer configuration management.
- Focused Gridfinity, openGrid, and OpenGrid Underware component editors, plus
  stateless OpenSCAD and build123d reconstruction, 3D preview, and
  STL export.
- Local-first Klippy log diagnostics with failure classification, MCU and
  thermal telemetry, event timelines, and self-contained HTML reports.

The public site is [klippee.xyz](https://klippee.xyz). Browse community printer
configurations in [Shared Configs](https://klippee.xyz/shared-configs), or open
[shared Orca profiles](https://klippee.xyz/shared-configs?type=orca).

## Self-host with Docker Compose

The experimental release runs the app and CAD service on a Linux AMD64 server
with Docker Engine, Compose v2, and at least 6 GB of RAM. It stores data in a
named Docker volume and runs without a Cloudflare account or OAuth credentials.

1. Save [`compose.example.yaml`](compose.example.yaml) and
   [`.env.example`](.env.example) in an empty directory. From one
   [`selfhost-v*` release](https://github.com/cl-tim/klippee-web/releases),
   download `klippee-app-linux-amd64.tar.gz`, `klippee-cad-linux-amd64.tar.gz`,
   and `SHA256SUMS` into that directory.
2. Copy the environment template and generate a session secret.

   ```sh
   cp .env.example .env
   openssl rand -hex 32
   ```

   Edit `.env` and paste the generated value into `SESSION_SECRET`. Set
   `KLIPPEE_VERSION` to the downloaded release tag and `APP_ORIGIN` to the HTTPS
   origin you will open in your browser, such as `https://klippee.example.com`.
   Keep `AUTH_MODE=local` for a shared workspace without sign-in.
3. Verify and load both images, then start the stack.

   ```sh
   sha256sum --check --ignore-missing SHA256SUMS
   docker image load --input klippee-app-linux-amd64.tar.gz
   docker image load --input klippee-cad-linux-amd64.tar.gz
   docker compose -f compose.example.yaml up -d --wait
   ```

Configure an [HTTPS reverse proxy](docs/self-hosting.md#https-reverse-proxy) to
forward your HTTPS URL to `127.0.0.1:8080`. In local mode, everyone who can reach
that URL can use the shared workspace. Restrict it to your trusted network or
VPN. The [self-hosting guide](docs/self-hosting.md) covers OAuth, backups,
upgrades, and source builds.

## Documentation

- [Product user guide](docs/user-guide/README.md)
- [Architecture](docs/architecture.md)
- [Authentication](docs/authentication.md)
- [Deployment](docs/deployment.md)
- [Self-hosting with Docker Compose](docs/self-hosting.md)
- [Production Readiness](docs/production-readiness.md)
- [Package Format](docs/package-format.md)
- [Public Catalog Review](docs/public-catalog-review.md)
- [UI Visual QA](docs/ui-visual-qa.md)
- [UI components and theme](docs/ui-components.md)
- [Config Editor](docs/config-editor.md)
- [Parametric CAD editors](docs/openscad.md)
- [Klippy Log Diagnostics](docs/log-diagnostics.md)
- [Web Editing and History](docs/web-editing-history.md)
- [Printer integration](docs/printer-integration.md)
- [OrcaSlicer integration](docs/orcaslicer-plugin.md)
- [Sync Behavior](docs/sync-behavior.md)
- [Safety Policy](docs/safety-policy.md)

## License

Klippee is licensed under GPL-2.0-or-later. Its native CAD container uses
OpenSCAD, build123d, and OpenCascade; see [NOTICE.md](NOTICE.md) and
[`server/CAD_NOTICE.md`](server/CAD_NOTICE.md).

## Development

Use Node.js 26 or Node.js 24.15 and later in the 24.x series.

```bash
npm run setup:dev
npm run test:ui:smoke:install
npm run dev
npm run check
npm run test:ui:smoke
```

The app is built with Vite, React, TypeScript, a Cloudflare Worker, and a Python
CAD service. `npm run setup:dev` installs npm packages, creates
`.dev.vars` from `.dev.vars.example`, creates a local Python `.venv`, and
installs the CAD service dependencies. The Chromium installation is needed once
for the development startup check. `npm run check` runs linting, license
audit, production build, Worker smoke tests, UI guardrails, CLI tests, Python
service tests, and the real Cloudflare/Vite startup check in Chromium.

Run `npm run check` before submitting changes. GitHub Actions builds the
Docker Compose release for `selfhost-v*` tags.

If local development logs a D1 error such as `no such table: companion_assets`,
apply the local migrations again:

```bash
npm run db:migrate:local
```

For screenshot-based browser review, first run
`npm run test:ui:smoke:install`, then `npm run test:ui:smoke`. The runner saves
desktop and mobile screenshots plus browser-error reports under
`artifacts/ui-smoke/`; see [UI Visual QA](docs/ui-visual-qa.md).

### Dependency overrides

The ESLint dependency tree pins Minimatch to `11.0.3` for
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The overrides target ESLint, `@eslint/config-array`, and
`@typescript-eslint/typescript-estree`, which still require Minimatch 10.
Remove them once all three resolve a patched version without overrides, then
verify `npm audit` and `npm run check`. When changing this pin, also verify that
ESLint still checks the same files and respects the configured ignore patterns.

### CAD Service

The parametric CAD workspace uses the stateless CAD service on port 8791:

```bash
npm run dev:cad
```

Its container-parity commands are `npm run docker:cad:build` and
`npm run docker:cad:run`. CAD requests use temporary directories and never use
D1 or R2 storage.

Cloudflare deploys build `Dockerfile.cad` and bind the Worker route `/api/cad/*`
to the CAD container. Docker must be running for Wrangler deploys or dry runs
that include the container.
