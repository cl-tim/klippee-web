# Production Readiness

Use this checklist when operating a Cloudflare deployment. Set
`KLIPPEE_BASE_URL` to your instance's HTTPS origin before running the smoke
and launch checks.

## Deployment Gate

Before pushing to your deployment branch, run locally:

```bash
npm run check
npm run predeploy
```

`npm run predeploy` verifies contiguous D1 migration files, required Cloudflare
bindings, stateless CAD processing, and that this deployment guidance remains
present.

Cloudflare must be configured with:

```text
Production branch: your deployment branch
Build command: npm run build
Deploy command: npm run deploy
```

The npm `predeploy` lifecycle runs the local guard before deployment.
`npm run deploy` then runs `npx wrangler d1 migrations apply DB --remote`
before `wrangler deploy`, so no separate migration step is required. Use
`npm run deploy:manual` only as a fallback when Cloudflare Workers Builds
cannot perform the deployment.

## Smoke Checks

Run the live smoke check after deployment:

```bash
npm run smoke:prod
```

Set a different target when testing a preview deployment:

```bash
KLIPPEE_BASE_URL=https://preview.example.workers.dev npm run smoke:prod
```

If production must have at least one renderable public package, require the
public package workflow checks too:

```bash
KLIPPEE_REQUIRE_PUBLIC_PACKAGE=1 npm run smoke:prod
```

For launch promotion, use the stricter verification command:

```bash
npm run launch:verify
```

This runs `npm run predeploy` and then requires:

```text
KLIPPEE_REQUIRE_PUBLIC_PACKAGE=1
```

A production launch is not complete until `npm run launch:verify` passes against
`https://klippee.example.com`. For preview launches, set `KLIPPEE_BASE_URL` before
running the same command.

The smoke check verifies:

- the static app shell loads with security headers
- the transient CAD container is healthy and explicitly reports that storage
  is disabled
- anonymous auth returns a valid JSON shape
- GitHub and Discord authorization redirects require S256 PKCE, include a
  43-character challenge, and never expose the verifier
- the public package catalog returns a package array
- private companion assets require authentication and public companion assets
  require explicit publish before package links hydrate publicly
- if a renderable package exists, anonymous render preview returns completed
  files
- if a renderable package exists, anonymous zip download returns a valid,
  ephemeral ZIP and reports that artifact storage was skipped
- `/api/health` confirms the Worker, primary D1 binding, required applied D1
  migration, and R2 binding

## R2 Artifact Policy

Production uses the `BLOBS` R2 binding for canonical content-addressed config
file bodies and private, expiring diagnostic uploads. Rendered public package
ZIPs are generated per request and never written to R2. Every ZIP response sends:

```text
x-klippee-artifact-storage: skipped
x-klippee-artifact-storage-reason: ephemeral-download
```

Older deployments wrote generated ZIPs under `artifacts/rendered-zips/`. The
scheduled Worker continues to reap those legacy objects past `expiresAt` (and
legacy objects without that metadata once their upload age passes 90 days).
Canonical package and repository versions remain in D1/R2 version storage and
are unaffected by that cleanup.

The daily maintenance runner keeps all six bounded cleanup tasks sequential,
but catches a task failure and attempts the remaining tasks before rejecting
the tracked scheduled promise. Workers Logs receive correlated structured
`scheduled_maintenance_task` and `scheduled_maintenance_run` events with a run
id, counts, durations, failed task names, and batch-limit warnings. Any task
failure therefore remains visible as a failed Cloudflare Cron Past Event
without starving unrelated retention work.

Migration `0021_canonical_blob_budgets.sql` backfills referenced canonical v2
content hashes and initializes aggregate budget counters. Every future
canonical blob is claimed in D1 before R2 is written, with a 512 MiB cumulative
charged budget per owner, a 20 GiB canonical-v2 service budget, and a 64 KiB
minimum charge per distinct hash. Verify this migration is applied before the
new Worker begins serving writes.

Migration `0022_canonical_blob_reclamation.sql` normalizes the four live v2
manifest sources, independently derives raw references for final drift checks,
and adds write leases, seven-day candidates, deletion fences, and audit events.
The `CANONICAL_BLOB_RECLAIMER` Durable Object serializes each hash's physical
delete and recovery attempt across Worker invocations.
Run `npm run storage:inventory -- --inventory-only` before treating the service
counter as a physical measurement. Legacy v1 snapshots and pre-migration
physical v2 orphans are reported separately.

Configure production lifecycle rules by prefix: 3 days for `diagnostics/`, 91
days for `diagnostic-improvements/`, and 91 days for the legacy
`artifacts/rendered-zips/` prefix. Never attach an age-only rule to
`blobs/sha256/`; those content-addressed bodies may still be referenced across
owners and require a reference-ledger claim check before safe reclamation.
Use only the dry-run/apply procedure in `docs/operations/r2-reclamation.md`; owner and
service claims must remain charged until R2 confirms the object absent.

## Authenticated Upload Rate Limits

Production requires both `DIAGNOSTIC_UPLOAD_RATE_LIMITER` (four requests per
60 seconds) and `LOG_IMPROVEMENT_RATE_LIMITER` (twenty-four requests per
60 seconds). A missing or unavailable binding
fails closed before Klippee reads the request body or reserves or writes upload
storage. Authentication may perform its normal D1 lookup first.

Printer diagnostics are keyed by the hashed owner/printer pair, so issuing a
second sync token does not reset the budget. Improvement submissions are keyed
by the authenticated user, so changing sessions does not reset that budget.
Cloudflare's counters are per location and permissive rather than exact global
accounting. They reduce routine upload churn; the atomic D1 row caps remain the
authoritative backstop during distributed or concurrent bursts.

Monitor HTTP `429` rates in Worker request logs and alert on sustained
increases. Clients receive the structured code `upload_rate_limit_exceeded`
and `Retry-After: 60`; request logs do not include that response body by
default. Rate-limit bindings are not separately visible as dashboard resources,
so `npm run predeploy` is the required configuration-drift check.

## Cloudflare Build Token

The Cloudflare build token must be created for your Cloudflare account and needs
permissions for every binding that Wrangler deploys:

- Workers Scripts edit
- D1 edit for the database bound as `DB`
- R2 edit for the bucket bound as `BLOBS`
- Containers edit
- Cloudchamber edit

After changing the build token in the Cloudflare UI, trigger a fresh deployment
from a new commit. Retrying an already-created failed build may keep using the
old build authorization context.

Re-run `npm run predeploy` after every binding change so config drift is caught
before the next deploy.

## Monitoring Targets

Recommended external uptime checks:

- `GET https://klippee.example.com/`
- `GET https://klippee.example.com/api/health`
- `GET https://klippee.example.com/api/auth/me`
- `GET https://klippee.example.com/api/cad/health`

Alert on any non-2xx response for these routes.

Suggested thresholds:

- Check interval: 1 minute for `/api/health`, 5 minutes for `/` and
  `/api/auth/me`.
- Timeout: 15 seconds, matching `KLIPPEE_SMOKE_TIMEOUT_MS`.
- Alert after 2 consecutive failures for `/api/health`.
- Alert after 3 consecutive failures for `/` and `/api/auth/me`.
- Alert after 3 consecutive failures for `/api/cad/health`.
- Alert on every failed `0 3 * * *` Cron Past Event. Use the matching
  `scheduled_maintenance_run` `runId` to inspect task failures, and investigate
  `batchLimitReached: true` warnings before cleanup backlogs become persistent.

## Failed Deployment Handling

- Migration failure: fix or roll forward the migration, run the local gates,
  and push the correction to your deployment branch.
- Build-token or binding failure: update Cloudflare permissions/resources and
  trigger Cloudflare Workers Builds from a fresh commit so the new authorization
  context is used.
- Smoke failure after deploy: deploy a correction and rerun the full
  smoke command after the next deployment.
