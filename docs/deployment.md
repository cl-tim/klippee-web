# Deployment Guide

This guide covers Cloudflare setup for your own Klippee instance. Replace
`klippee.example.com` with your domain throughout.

Production is a Cloudflare Worker that serves the built Vite/React frontend as
static assets, handles `/api/*`, uses D1 for metadata, and uses R2 for config
blobs and private diagnostic uploads. The CAD service runs as a transient
Cloudflare Container.

Docker Compose builds the same frontend and Worker from the same source tree.
Cloudflare provides the storage and CAD bindings for this deployment, and
GitHub and Discord OAuth provide browser sign-in. The Compose runtime uses
local storage and lets the operator choose sign-in mode. See
[Self-hosting](self-hosting.md).

HTML routes run through the Worker to receive a fresh Content Security Policy
script nonce on every response. Cloudflare copies this nonce onto its injected
JavaScript Detections scripts; arbitrary inline scripts remain blocked. HTML
responses use `Cache-Control: no-store` so nonces are not reused. Keep HTML
routes in `assets.run_worker_first`; `/assets/*` and `/install/*` remain direct
static downloads. The static and Worker policies both allow only the specific
Cloudflare Web Analytics beacon URL in addition to same-origin scripts. The
automatically injected beacon reports to the same-origin `/cdn-cgi/rum`, so
`connect-src 'self'` remains sufficient.

References: [JavaScript Detections and CSP](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp)
and [Web Analytics CSP requirements](https://developers.cloudflare.com/web-analytics/faq/#what-do-i-need-to-add-to-my-content-security-policy-csp).

## Accounts Needed

- Cloudflare account
- GitHub account with access to your fork of Klippee
- Discord developer account
- GitHub developer settings access
- Domain control for `klippee.example.com`

## 1. Domain Setup

In Cloudflare:

1. Add `klippee.example.com` as a site.
2. If the domain was bought outside Cloudflare, update the registrar
   nameservers to the nameservers Cloudflare assigns.
3. Wait until Cloudflare marks the zone active.
4. Keep DNSSEC disabled until the nameserver move is complete, then enable it
   later if desired.

For a Worker-only app, prefer a Cloudflare Worker Custom Domain for
`klippee.example.com`. Cloudflare recommends Custom Domains when the Worker is the
application origin.

Expected production URLs:

```text
https://klippee.example.com
https://klippee.example.com/api/*
```

Optional:

```text
https://www.klippee.example.com -> https://klippee.example.com
```

## 2. Install and Authenticate Wrangler

Use Node.js 24, matching `engines` in `package.json` and the committed
`.node-version`.

Install dependencies:

```bash
npm install
```

Log in to Cloudflare:

```bash
npx wrangler login
```

Confirm the local app is healthy:

```bash
npm run test:ui:smoke:install
npm run check
```

The Chromium installation is needed once for the development startup check.

## 3. Create Cloudflare Resources

### D1

Create the production database:

```bash
npx wrangler d1 create klippee-example-db
```

Record the returned database ID. The all-zero ID in `wrangler.jsonc` is a
placeholder for local builds. Replace it before deploying.

Initial binding name:

```text
DB
```

### R2

Create the production blob bucket:

```bash
npx wrangler r2 bucket create klippee-example-blobs
```

Initial binding name:

```text
BLOBS
```

Rendered ZIP downloads are ephemeral and are never stored in R2. Older
deployments wrote generated artifacts under `artifacts/rendered-zips/`; the
daily scheduled Worker retains its reaper solely to drain those legacy objects.
Configure prefix-scoped lifecycle expiration as defense in depth for temporary
object classes:

- `diagnostics/`: 3 days (application retention is 48 hours)
- `diagnostic-improvements/`: 91 days (application retention is 90 days)
- `artifacts/rendered-zips/`: 91 days while legacy objects remain

Do not apply those rules to `blobs/`, `snapshots/`, or `imports/`. In
particular, `blobs/sha256/*` can be shared by current versions and packages
across owners; it needs a reference ledger and grace-period claim check before
automated garbage collection is safe.

After migrations `0021` and `0022`, use the bounded workflow in
`docs/r2-reclamation.md` to inventory every namespace and compare
`blobs/sha256/*` with both normalized and raw retained-manifest references. It
reports pre-existing physical orphans and legacy v1 repository snapshots
separately. Canonical deletion requires a seven-day observed grace and explicit
operator apply; legacy v1 data remains report-only.

## 4. Add Worker Configuration

The committed `wrangler.jsonc` is the authoritative source configuration.
It serves `/api/*` through the Worker, serves the frontend through the static
asset pipeline, and declares every stateful or protective binding. Note that
what Wrangler actually deploys is the build output config generated from it by
the Cloudflare Vite plugin (see the deploy-config redirect in section 9):

| Binding | Purpose |
| --- | --- |
| `ASSETS` | Built frontend assets |
| `DB` | Production D1 database |
| `BLOBS` | Canonical files and private diagnostic objects |
| `CAD_CONTAINER` | Transient CAD service |
| `CANONICAL_BLOB_RECLAIMER` | Per-hash serialization for canonical R2 deletion and recovery |
| `AUTH_RATE_LIMITER` | OAuth state-creation abuse protection |
| `CAD_RATE_LIMITER` | Public CAD compute protection |
| `PACKAGE_RATE_LIMITER` | Public package render/download protection |
| `DIAGNOSTIC_UPLOAD_RATE_LIMITER` | Four authenticated printer uploads per printer per 60 seconds |
| `LOG_IMPROVEMENT_RATE_LIMITER` | Twenty-four improvement submissions per user per 60 seconds |

The rate-limit namespace IDs in `wrangler.jsonc` are examples. Assign a
different positive integer string to each binding using IDs that are unused in
your Cloudflare account. The predeploy check verifies uniqueness in this file.
Wrangler creates the bindings from
`wrangler.jsonc` as part of the normal `npm run deploy` path.

The Vite Cloudflare integration simulates these bindings from the same config
for local development. Before deploying, set `APP_ORIGIN` to your HTTPS origin
and replace the D1 database name and ID, the R2 bucket name, and the rate-limit
namespace IDs in `wrangler.jsonc` with your own. Standalone Miniflare tests use
separate test namespaces. Run `npm run predeploy`
after any binding change; the check rejects missing, duplicated, or drifted
upload limits before deployment.

## 5. Configure Secrets

Set production secrets once the Worker API uses authentication:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put LOG_IMPROVEMENT_REVIEW_TOKEN
npx wrangler secret put STORAGE_MAINTENANCE_TOKEN
```

Local development can use `.dev.vars`, which must not be committed:

```text
SESSION_SECRET=local-dev-secret
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
LOG_IMPROVEMENT_REVIEW_TOKEN=...
STORAGE_MAINTENANCE_TOKEN=...
APP_ORIGIN=http://localhost:5173
```

During `npm run dev`, Vite marks its injected scripts and nonce metadata with a
placeholder using [`html.cspNonce`](https://vite.dev/guide/features#content-security-policy-csp).
The development Worker replaces those marked attributes with the fresh nonce
in that response's CSP. This lets React refresh run without allowing arbitrary
inline scripts. The rewrite is enabled by Vite's development build flag, not a
request hostname or local-auth setting. Production builds retain the existing
strict policy and fresh, uncached HTML nonces.

`npm run test:dev` exercises this path through the actual Cloudflare Vite plugin
and Chromium. It is included in `npm run check`; install Chromium once with
`npm run test:ui:smoke:install`.

`LOG_IMPROVEMENT_REVIEW_TOKEN` protects developer access to logs that users
explicitly submit for analyzer improvements. Generate a long random value,
store it only as a Cloudflare secret, and do not reuse an OAuth or session
secret.

`STORAGE_MAINTENANCE_TOKEN` protects bucket inventory, candidate creation, and
canonical reclamation. Use a separate random value and expose it only to the
operators following `docs/r2-reclamation.md`.

## 6. GitHub OAuth App

Create a GitHub OAuth app:

GitHub settings path:

```text
GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App
```

Production values:

```text
Application name: Klippee
Homepage URL: https://klippee.example.com
Authorization callback URL: https://klippee.example.com/api/auth/github/callback
```

Local callback for development:

```text
Homepage URL: http://localhost:5173
Authorization callback URL: http://localhost:5173/api/auth/github/callback
```

Recommended scopes:

```text
read:user
```

Do not request `user:email` or repository scopes for normal login.

## 7. Discord OAuth App

Create a Discord application:

```text
Discord Developer Portal -> Applications -> New Application
```

In OAuth2 settings, add redirect URLs:

```text
https://klippee.example.com/api/auth/discord/callback
http://localhost:5173/api/auth/discord/callback
```

Recommended scopes:

```text
identify
```

Do not request `email`, bot, or guild permissions for normal login.

## 8. D1 Migrations

Migrations live in `migrations/` as numbered, gap-free `NNNN_name.sql` files
(`npm run predeploy` enforces the sequence). Create a new migration with:

```bash
npx wrangler d1 migrations create DB short_description
```

Apply locally:

```bash
npx wrangler d1 migrations apply DB --local
```

Cloudflare Workers Builds runs `npm run deploy`, which applies
`npx wrangler d1 migrations apply DB --remote` before `wrangler deploy`. No
separate migration command is needed during a normal deployment. To apply
migrations without deploying the Worker, for example for an intentional
schema-only operation:

```bash
npx wrangler d1 migrations apply DB --remote
```

Because migrations run before the new Worker is deployed, destructive column
removal must use two releases. First deploy code that no longer reads or writes
the column; only a later migration may drop it. Migration 0019 therefore removes
the obsolete known-good field from the application model but deliberately leaves
the legacy D1 column in place for one compatibility release.

Migration `0023_oauth_pkce.sql` adds nullable verifier storage so the old Worker
remains compatible during the migrations-before-deploy window. The new Worker
always writes a 43-character verifier and rejects legacy/null or malformed
states before contacting GitHub or Discord. A sign-in started before this
deployment may need to be restarted; no session or provider token is affected.

`/api/health` verifies that the migration required by the deployed Worker is a
member of Cloudflare's default `d1_migrations` ledger on the primary D1
database. It deliberately does not require that row to be the ledger maximum:
the old Worker must remain healthy after the next migration is applied and
before the next Worker version is deployed. `npm run predeploy` keeps the
required marker in `worker/routes/health.ts` synchronized with the newest
repository migration and rejects a custom migration-table name.

The core tables established by the existing migrations include:

- `users`
- `user_identities`
- `sessions`
- `sync_tokens`
- `printers`
- `packages`
- `package_versions`
- `package_files`
- `package_variables`
- `printer_variable_values`
- `repositories`
- `repository_versions`
- `trees`
- `tree_entries`
- `blobs`
- `version_scan_results`
- `companion_assets`
- `public_companion_assets`

Before deploying, run the local release guard:

```bash
npm run predeploy
```

This verifies that migration files are present and ordered without gaps, the
health marker matches the newest migration, and `wrangler.jsonc` still declares
the required production bindings: `ASSETS`, `DB`, `BLOBS`, and
`CAD_CONTAINER`.

## 9. Cloudflare Git Deployment

Cloudflare Workers Builds can deploy from a branch you select in your
repository. Each push to that branch triggers a build and deploy.

Configure the Cloudflare build with:

```text
Production branch: your deployment branch
Build command: npm run build
Deploy command: npm run deploy
```

To keep deployment settings outside Git, set `KLIPPEE_WRANGLER_OVERRIDES`
as a protected build variable and use `npm run build:cloudflare` as the build
command. Set the variable to a JSON object with your HTTPS `vars.APP_ORIGIN`,
the `d1_databases` entry for `DB`, and the `r2_buckets` entry for `BLOBS`.
The arrays replace the corresponding arrays in `wrangler.jsonc`. You can also
provide `ratelimits`, `placement`, and `observability` for your environment.

```json
{
  "vars": { "APP_ORIGIN": "https://app.example.com" },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "example-app-db",
    "database_id": "11111111-2222-4333-8444-555555555555"
  }],
  "r2_buckets": [{ "binding": "BLOBS", "bucket_name": "example-app-blobs" }]
}
```

The command writes a Git-ignored `wrangler.json` that takes precedence over
the template during build, predeploy checks, and D1 migrations. The deploy
command checks the bundled bindings before running migrations. Use this in an
isolated build checkout. For an existing Worker, reference its existing D1
database and R2 bucket. Set OAuth and session credentials as runtime secrets on
that Worker. Keep production build settings available only to a trusted branch.

The npm `predeploy` lifecycle runs `npm run predeploy` automatically before the
deploy script. The deploy script then verifies it is running in CI, applies D1
migrations, and invokes Wrangler. Plain `npm run deploy` refuses to run when
neither `WORKERS_CI` nor `CI` is set (see `scripts/ci-only.mjs`): run locally
it would migrate production and ship a possibly stale local `dist/`.

### The Vite plugin deploy-config redirect

`npm run build` runs `tsc -b && vite build` with `@cloudflare/vite-plugin`.
The plugin writes:

- `dist/client/` — the built frontend assets
- `dist/klippee/index.js` — the bundled Worker
- `dist/klippee/wrangler.json` — a generated, resolved copy of
  `wrangler.jsonc` whose `main`, `assets.directory` (`../client`), and D1
  `migrations_dir` point into the build output
- `.wrangler/deploy/config.json` — a redirect file telling Wrangler to use
  `dist/klippee/wrangler.json` instead of the committed `wrangler.jsonc`

When `npm run deploy` runs `wrangler deploy`, Wrangler follows that redirect,
so the deployed Worker and assets always come from the build output. The
committed `wrangler.jsonc` therefore stays the human-edited source of truth
for bindings, while `assets.directory` in it (`./dist/client`) is kept aligned
with the real client output — `npm run predeploy` enforces this — so a bare
`wrangler deploy` without the redirect can never upload the Worker bundle as a
public static asset. If a Wrangler or Vite plugin major changes this redirect
mechanism, the build or the predeploy check should fail loudly rather than
deploy the wrong asset tree.

Before pushing to your deployment branch, run locally:

```bash
npm run check
npm run predeploy
```

If Cloudflare Workers Builds is unavailable and a manual deployment is
necessary, use the explicit fallback:

```bash
npm run deploy:manual
```

Set `KLIPPEE_BASE_URL` to your own deployed origin before running smoke or
launch checks. The predeploy CLI version check reads `APP_ORIGIN` from
`wrangler.jsonc` unless you set `KLIPPEE_BASE_URL`.

`npm run launch:verify` requires the transient CAD route and at least one
renderable public package. Run it after Cloudflare publishes a launch change.
Run `npm run smoke:prod` after other changes.

## 10. Attach Domain

In Cloudflare dashboard:

```text
Workers & Pages -> klippee -> Settings -> Domains & Routes -> Add -> Custom Domain
```

Add:

```text
klippee.example.com
```

Optional:

```text
www.klippee.example.com
```

If using `www`, configure a redirect to the apex domain.

## 11. Post-Deploy Checks

Check:

- `https://klippee.example.com` loads the app.
- Refreshing a deep route still serves the SPA.
- `/api/auth/me` returns anonymous state before login.
- GitHub login redirects back to Klippee.
- Discord login redirects back to Klippee.
- Session cookie is `HttpOnly`, `Secure`, and `SameSite=Lax`.
- D1 reads/writes work and `/api/health` reports `checks.d1Schema: true` for
  the Worker-required migration.
- R2 health passes in `/api/health`.
- Public package render and zip download pass in `npm run smoke:prod` when the
  catalog has a renderable public package. Use
  `KLIPPEE_REQUIRE_PUBLIC_PACKAGE=1 npm run smoke:prod` before launches that
  depend on seeded public packages.
- Private edits create versions.
- Printer sync tokens cannot access browser-only endpoints.

## 12. Workers Builds Configuration

Connect your fork in the Cloudflare dashboard, select
your production branch, and use `npm run build` and `npm run deploy` as
the build and deploy commands. The Cloudflare build token must have permission
to update the Worker and its bindings.

Run `npm run check` and `npm run predeploy` before pushing changes to your
deployment branch. Cloudflare Workers Builds handles the automatic deployment.

Confirm the Cloudflare settings after changing either npm script. Trigger a
fresh deployment with a new commit to the deployment branch. Retrying an old build can
retain its old authorization context.

## 13. Failed Deploy Recovery

If deployment fails:

1. Check whether the failure happened before or after `wrangler deploy`.
2. If migrations failed, stop and fix the migration before retrying deploy.
3. If Wrangler reports a missing binding or permission, update the Cloudflare
   build token or resource binding, then trigger a fresh deployment from a new
   commit.
4. If the Worker deployed but smoke checks fail, fix forward, run the local
   gates, and push the correction to the deployment branch.
5. After a retry succeeds, run `npm run smoke:prod` again and record any
   production-only follow-up issue.

## 14. Production Security Checklist

- Keep OAuth client secrets in Cloudflare secrets only.
- Do not commit `.dev.vars`.
- Rotate `SESSION_SECRET` before launch if it was used in testing.
- Restrict sync tokens to one printer profile.
- Store provider access tokens only if a feature truly needs them.
- Keep public packages templated; do not publish user-specific device IDs.

## 15. Deployment Checklist

Before pushing to your deployment branch, verify:

- `npm run check` passes on the commit being pushed.
- `npm run predeploy` passes.
- Cloudflare Workers Builds uses your deployment branch, `npm run build`, and `npm run deploy`.
- D1 migrations will be applied automatically by `npm run deploy` before the
  Worker is updated. No separate migration step is needed.
- `wrangler.jsonc` still includes `DB`, `BLOBS`, `ASSETS`, `CAD_CONTAINER`, and
  `CANONICAL_BLOB_RECLAIMER`.
- Cloudflare build token permissions cover Workers Scripts, D1, R2, Containers,
  and Cloudchamber.
- OAuth secrets are configured and callback URLs match your `APP_ORIGIN`.
- The configured R2 bucket exists and generated ZIP downloads remain
  ephemeral, and lifecycle rules are prefix-scoped as described above.
- `STORAGE_MAINTENANCE_TOKEN` is configured. After this migration and Worker
  deploy, capture and review an inventory-only report under
  `docs/r2-reclamation.md` before any reclamation apply.
- Post-deploy smoke checks pass against `https://klippee.example.com`.
- Launch releases pass `npm run launch:verify` against `https://klippee.example.com`.
- `CAD_CONTAINER` is deployed from `Dockerfile.cad`, `/api/cad/health` reports
  `storage: none`, and the CAD container has no D1 or R2 storage binding.

## Sources

- Cloudflare Workers Static Assets:
  https://developers.cloudflare.com/workers/static-assets/
- Cloudflare Workers Routes and Domains:
  https://developers.cloudflare.com/workers/configuration/routing/
- Cloudflare DNS nameservers:
  https://developers.cloudflare.com/dns/nameservers/update-nameservers/
- Cloudflare Workers environment variables and secrets:
  https://developers.cloudflare.com/workers/configuration/environment-variables/
- Cloudflare D1 getting started:
  https://developers.cloudflare.com/d1/get-started/
- Cloudflare Workers Builds configuration:
  https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- GitHub OAuth:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- Discord OAuth2:
  https://docs.discord.com/developers/platform/oauth2-and-permissions
