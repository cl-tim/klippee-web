# Architecture

Klippee is a Klipper configuration sharing and private sync service designed to
run on Cloudflare.

## Product Modes

### Shared Configs

Shared Configs stores shareable config packages for printer models and
mods. Users should be able to browse, filter, diff, configure, download, and
fork packages. When a private printer workspace is published, its public
listing is linked to both that workspace's repository and its named printer,
but its files are a separate owner-approved snapshot. Every anonymous detail,
catalog, render, and download request serves that stored snapshot. A mutable
editor draft, desktop draft, or later printer-applied revision is private until
the owner explicitly republishes it or opts the linked listing into automatic
updates. Automatic updates follow only physically confirmed applies/captures;
pending drafts never become public through this setting.

The catalog is at [`/shared-configs`](https://klippee.xyz/shared-configs), with
Orca profiles at [`/shared-configs?type=orca`](https://klippee.xyz/shared-configs?type=orca).
Legacy `/registry` and `/registry/` links return a permanent HTTP 308 redirect
to `/shared-configs`, preserving query strings.

Packages should be discoverable by:

- printer manufacturer and model
- controller board
- probe or bed leveling hardware
- extruder and hotend
- enclosure or accessory systems
- Klipper, Moonraker, Fluidd, and Mainsail compatibility notes
- package tags

### Private Sync

Private sync keeps two deliberately different states for each printer:

- a mutable pending draft, updated by the web editor or a baseline-checked
  desktop capture; and
- the immutable configuration last confirmed as installed by the physical
  printer.

The printer-side client can compare local files with the current target, apply
that target explicitly, deliberately capture its local files as the confirmed
configuration, and recover after a bad edit. Autosaving or publishing a draft
never advances the printer's applied pointer.

Private repositories are not searchable and should require scoped sync tokens.

### Web Editing

Web editing is the primary authoring surface for private printer
configurations. Edits autosave into one mutable pending draft. The printer can
inspect that target and explicitly apply it, at which point the exact files and
content revision used to render the printer files are captured as an immutable
version and become the printer's applied state.

Edits never overwrite printer state silently and do not create a false history
of applied configurations. If the workspace has a Shared Configs listing, it
continues to serve the last owner-approved snapshot while a draft is pending and
after the physical printer confirms a later apply or capture. The owner is shown
that the newer applied configuration is unpublished. By default, the owner must
review and republish it before public files change. In the Shared Configs
publisher, an owner can enable **Automatically update this shared listing** for a linked
printer. Enabling also catches up to its current applied version. Later physical
applies and captures update that same public URL while preserving listing
metadata. Desktop captures and editor saves remain private drafts.

Automatic updates use the same public-file exclusions and variable sanitization
as manual publication. Template placeholders stay templated. Generic
heater/motion/pin review hints are covered by opt-in; other blocking or specific
safety findings (including device/network identities and missing includes) pause
the public update for review. The last public snapshot
stays available, and the publisher shows a retry/review message. Publication
failure never changes the success of a physical apply. Repeated physical reports
retry outstanding publication work. Turning the option off freezes the current
public snapshot; deleting or rebinding its printer also disables the option.

### Config Editor

The config editor lets a user open a package, enter printer-specific variable
values, preview the rendered config, and download a ready-to-install `.zip`
without setting up private sync.

For example, a user browsing a QIDI X-Plus 4 package with Beacon and Box support
can enter their Beacon USB serial path and QIDI Box MCU serial paths, then export
rendered config files for their own printer.

### Companion Assets

Companion assets track slicer profiles/snippets and filament settings alongside
Klipper config packages. They are account-scoped by default, can be linked to a
private package by stable asset id, and can be published explicitly when the
profile is safe to share.

Public package responses hydrate linked companion assets only after the matching
asset has a public share row. This lets a package point at the exact slicer or
filament setup that was confirmed alongside it without leaking private profiles
by accident.

## Cloudflare Components

### Worker

The Worker owns the HTTP API and can serve the frontend as static assets.

Responsibilities:

- request routing
- primary-consistent D1 migration readiness and R2 binding health
- auth session handling
- OAuth callbacks for GitHub and Discord, with per-flow S256 PKCE binding
- Shared Configs catalog reads
- private sync reads and writes
- package manifest validation
- package variable validation
- web edit validation
- printer-local render planning
- rendered zip generation
- version creation and diff APIs
- safety scan orchestration
- signed upload and download flows for larger artifacts
- bounded daily maintenance with per-task failure isolation and structured
  Cloudflare Cron observability

### D1 access with Drizzle

All application D1 reads and writes use Drizzle ORM 0.45.4. Models for all 34
application tables in `worker/schema.ts` provide column and result types.
Shared Configs catalogs use the existing `first-unconstrained`
D1 read session; the Orca page and its nozzle facets share that same session.

Repository and version-history reads in `RepositoryRepository` also use
Drizzle, including quota counts, ownership checks and restore/delete preflight
reads. Explicit projections preserve the existing API fields. List helpers
return row arrays; missing single rows retain
the native D1 `null` behavior.

Physical-printer management reads use `PrinterRepository` for listings, owned
and bound-printer lookups, quota/upsert preflight, publication candidates and
saved variable values used in rendering. Their primary sessions and existing
response/secret filters are preserved. Publication candidates retain the left
join to the applied repository version, including a null candidate when no
matching version exists. Upserts, repository rebinding and deletion use Drizzle
D1 batches. Per-variable writes keep secrecy and size checks inside the update.

Private package and companion-asset reads use `PrivatePackageRepository` and
`CompanionAssetRepository` for owned listings/lookups, save quota checks and
private attachment loading. Package publication and listing edits reuse the
owned-package lookup on their existing primary session. Package save preflight
keeps its existence flag and owner count in one statement, including an empty
library. Existing summary/content filtering, malformed-record responses and
attachment deduplication/order remain in the response and loading layers.

Public detail reads use `PublicPackageRepository` and
`PublicCompanionAssetRepository` for slug/name lookups, published attachments,
linked Orca summaries and owner publication-state lookups. The latter reuse
primary sessions before edits or automatic-update settings change. Left joins
keep missing applied versions/context nullable, and linked asset/config joins
require matching publishers. Public bodies still come from the stored approved
snapshot; current printer state is reported separately by the status endpoint.

Automatic publication reads reuse the same primary session for opted-in
listings, the owned private secret metadata and the printer's applied version.
`PrinterRepository.getAppliedVersion` is also shared by manual publication and
conflict reclassification. `PackageSecretRepository` reads owned private and
slug-bound public definitions with one `UNION ALL` statement. Distinct binding
IDs come from JSON subqueries, keeping the parameter count constant for large
binding lists while retaining both sources' declarations. Built-in definitions,
secret filtering and atomic scrub/publication guards remain in their existing
layers.

Sync-token management and authentication reads use `SyncTokenRepository` for
owner/repository listings, quota preflight and the token/repository join.
`PrinterRepository.getSyncTokenBinding` checks owned printer bindings before
creation. Listings retain the public field projection without credential
hashes. Authentication, quota checks and binding reads keep their existing
primary sessions; expiry/scope checks, desktop-client classification and
debounced activity decisions stay in the route layer. Guarded token inserts,
activity updates, printer binding updates and revocation now use Drizzle too.
Repository deletion preflight uses the existing printer/publication repositories
for applied and approved references. Health probes use parameterized Drizzle SQL
for the platform-owned `d1_migrations` table.

Desired-configuration reads use `RepositoryRepository.getDesiredSnapshot` to
join the stored latest-version pointer, retaining nullable version fields for
empty or missing-pointer repositories. Draft selection, R2 loading, blob-cache
reuse and revision calculation stay in `loadDesiredConfiguration`. Sync target,
capture context, printer-name and legacy binding-candidate reads use
`PrinterRepository`; applied reports use a repository-scoped version lookup.
The sync routes keep their existing primary/read sessions, template-preservation
rules and conflict responses. Legacy repair still requires exactly one owned
candidate, and apply, draft and recovery mutations retain their original guards.

Orca setup and connection access uses `OrcaSetupRepository`,
`OrcaCaptureRepository` and `OrcaDeviceRepository` on the existing primary
sessions. Setup listings/downloads retain owner and optional printer filters,
and use the stored nullable printer association. Capture grants retain the
owner-matched printer-name left join, expiry check and enabled-device subquery.
Pairing/upload confirmations still match the credential and operation context;
device listings retain their public projection and boolean conversion. Grant,
setup, pairing, permission and revocation writes now use Drizzle builders with
the same atomic guards and retry handling.

Orca library and publication access is also fully migrated. Read snapshots use
Drizzle batches so concurrent imports cannot mix library revisions. Imports
repeat their grant/replay guard on each mutation and insert the receipt last in
one atomic batch. Joined columns with overlapping names have explicit SQL
aliases because D1 batch rows are keyed objects before Drizzle maps them by
position. Publication upserts and automatic updates retain their quota,
import revision, prior body/timestamp and linked-config predicates. A Worker
integration test forces the final receipt to fail and verifies full rollback
before a successful retry.

Authentication and cloud app-state access use `AuthRepository` and
`AppStateRepository`. OAuth state is consumed by an atomic delete/returning
query; creation retains its bounded cleanup and active-state cap in one batch.
User/identity updates and session creation/retention remain atomic. State
cleanup and autosaves keep their exact compare-and-swap predicates and reload
the primary row after conflicts. PKCE, cookie handling and content sanitization
remain in the route layer.

`drizzleDb` exposes select and mutation builders, parameterized SQL operations
and D1 batches on the supplied client. It does not expose interactive
transactions; D1 atomic operations use batches. `drizzleReadDb` retains a
select-only interface. Both prevent the driver from bypassing the caller's
session. Callers choose the session: reads that
precede writes or reload staged configuration keep their `first-primary`
session, while other reads retain their existing consistency mode.
Database error boundaries unwrap Drizzle query errors to the underlying D1
cause before logging or classifying retries. Drizzle wrapper messages and
stacks include bound values, so they must not enter logs or API responses.
Atomic D1 batches contain query builders. Do not batch raw `run(sql)`,
`all(sql)` or `get(sql)` operations: the current D1 driver requires prepared
statement handles that those raw operations do not expose.
`DrizzleWriteBatch` accepts non-returning write builders and preserves D1
change metadata across heterogeneous mutation batches.

Diagnostic uploads, consented log submissions and their shared retention and
expiry lifecycle use Drizzle. Typed owner scopes replace positional predicate
fragments. Reservations retain quota/ownership guards; finalization still
requires the original object key and a pending size of zero. Cleanup claims
pending rows before R2 deletion and fences row deletion on both id and object
key. Browser/desktop draft staging also uses the same guarded Drizzle update.

Blob reservations, quota ledgers, write leases, storage confirmation, inventory
and fenced reclamation now use Drizzle. Repository creation, version append,
lineage rewiring/deletion, sync status and conflict-guarded recovery do too.
Printer, package and companion-asset writes preserve ownership/quota limits,
approval provenance, optimistic conflict guards and API projections. Secret
scrubbing accepts typed SQL predicates, chunks paths below D1's parameter
limit and stays atomic with publication/reclassification. Listing metadata
mirrors retain their `changes()` guard. Native D1 handles are confined to
`worker/db.ts`; an architectural test guards that adapter boundary.

Workspace conflict review reads the owned repository's current desired snapshot
from the primary-backed history endpoint and verifies its content revision.
Browser records retain a local `workspaceBaseFiles` snapshot alongside their
baseline revision; cloud app-state backups omit this redundant snapshot. Legacy
baselines can be recovered from immutable history. Missing baselines are shown
as unavailable and never inferred from the latest cloud contents.

The review preserves independent file edits and requires explicit choices for
competing edits or delete/edit conflicts. Confirmation refetches the cloud,
requires an unchanged local workspace and owner/printer/repository scope, scans
the proposed files for blocking safety findings, and stages with that fresh
content revision through the existing authenticated CAS endpoint. A changed
cloud revision resets the review choices. A failed/uncertain write or a local
edit during the request preserves the working draft and keeps sync paused.
Only a confirmed result replaces the local workspace and advances its baseline.
Outdated staging responses cannot clear newer conflicts or regress the baseline.
Reload reconciliation refreshes only caches unchanged from their own baseline;
an intentional reversion remains a local edit after further cloud changes.
Content-only drafts retain their original file set, including locally edited
files removed by a newer capture. Legacy baseline guards use the cached source
snapshot rather than rebasing old edits onto a newly fetched capture.

Single-file history recovery reads the owned immutable source and current desired
revision, then previews the replacement against the live local workspace. It
preserves unrelated local edits and can re-add a file removed from the draft.
Confirmation refetches the source and revision, rejects changed local workspaces
or source identities, scans the result for safety findings, and stages through
the existing pending-configuration CAS endpoint. Applied printer state and
immutable history stay unchanged. Cancellation before confirmation performs no
restore write. Leaving Recovery during an uncertain write retains the local
workspace and pauses sync for conflict review. The legacy `restore-file` API,
which creates an immutable version, is not used by this draft workflow.

The SQL files in `migrations/` remain authoritative for the complete schema,
constraints and indexes. Wrangler continues applying the existing migration
history. The query models are not a migration-generation schema;
do not use them with `drizzle-kit push` or to regenerate the database. This
adoption requires no schema or data migration. Worker integration tests compare
the models against every application table in migrated D1, including checking
that no application table is missing a model, and verify catalog visibility, filtering,
ordering, summary fields and pagination, plus repository ownership, empty
histories, version ordering, restore/delete and printer sync behavior.

### Transient CAD Container

The parametric CAD studio uses a dedicated Python CAD container. The Worker
rate-limits `/api/cad/*`, pins requests to one
container instance, and streams responses back to the browser. OpenCascade
analyzes STEP, IGES, and BREP boundary representations for native parametric
primitives and produces adjustable reference geometry where recognition is not
defensible. The OpenSCAD CLI renders submitted `.scad` source to STL. build123d
renders server-generated validated reconstruction plans to STL. Browser-provided
Python is never executed.

Each request runs in a temporary directory. The CAD container has no D1 or R2
binding, and the Worker exposes no CAD persistence API. Source, parameters,
generated source, and generated STL are discarded after the response. The UI
previews returned STL buffers with Three.js.

### Browser Log Diagnostics

Klippy log analysis runs entirely in the browser. The frontend reads a
user-selected file, separates Klipper sessions, parses `Stats` telemetry, and
applies an explicit failure-rule taxonomy. Source logs and generated analysis
state are not sent to the Worker or persisted in account state unless the user
separately opens **Submit for improvements**, accepts both consent statements,
and submits the selected source files. Those contributed samples are
gzip-normalized in R2, have consent and expiry metadata in D1, are available
only through a secret-protected developer review API, and expire after 90 days.

Authenticated diagnostic storage mutations are throttled before request bodies
are consumed. Printer uploads share a stable owner/printer budget across sync
tokens, while analyzer-improvement submissions share a user budget across
sessions. The Cloudflare counters shape per-location abuse; atomic D1 retention
caps remain the exact storage backstop.

The downloadable HTML report is rendered from the same analysis model used by
the browser workspace. It is self-contained and preserves source line evidence,
MCU endpoints, temperature ranges, and a filterable event timeline.

### D1

D1 stores relational metadata.

Suggested tables:

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
- `public_packages`
- `trees`
- `tree_entries`
- `blobs`
- `package_tags`
- `version_scan_results`
- `stars`
- `forks`
- `companion_assets`
- `public_companion_assets`

`package_variables` defines placeholders required by a package, such as
`${KLIPPEE:beacon_serial}`. `printer_variable_values` stores the private values
for a user's printer installation profile.

Secret variable values should be encrypted or kept local to the sync client. If
stored server-side, they must never be exposed through public catalog APIs,
public rendered previews, or search indexes.

The repository row also holds the mutable pending file manifest and its update
time. That single size-bounded draft stays inline in D1, so replacing an
autosaved draft does not create abandoned immutable objects. Repository
versions provide lightweight immutable history without
requiring Git. A version records its previous version, timestamp, message,
safety scan status, and source such as `printer-apply`, `capture`, `recovery`,
or `import`. Persisted version messages are limited to 512 UTF-8 bytes and
sources to 64 UTF-8 bytes. Each file manifest also limits paths to 180 UTF-8
bytes and roles to 64 UTF-8 bytes, preventing small row-count limits from being
bypassed with oversized metadata. Sync-token display names are limited to 128
UTF-8 bytes for the same reason. Printer IDs are restricted to 128 ASCII
letters, numbers, dots, underscores, or hyphens so they remain safe in R2 keys;
printer names are limited to 256 UTF-8 bytes.

Persistent D1 collections have explicit owner-scoped limits. Their final write
uses a primary D1 `INSERT ... SELECT` guard rather than trusting a preliminary
count, so concurrent requests cannot cross the boundary:

| Resource | Limit |
| --- | ---: |
| Configuration repositories per user | 32 |
| Retained versions per repository | 256 |
| Printers per user | 32 |
| Sync tokens per repository | 16 |
| Private packages per user | 64 |
| Companion assets per user | 64 |
| Active browser sessions per user | 10 |
| Cumulative canonical file-body claims per user | 512 MiB charged |

Updates to an existing printer, private package, or companion asset remain
available at capacity. A rejected creation returns HTTP `409` with
`code=storage_quota_exceeded`, the stable resource id, and the numeric limit.
Sign-in keeps the new session plus the nine newest active sessions; the daily
job removes expired sessions and OAuth states. Sync-token activity timestamps
are written at most once every 15 minutes instead of on every poll.

Owners can delete an unused cloud configuration from **Printers → Saved
configurations**. `GET /api/repos?manage=1` reads owner-only metadata from a
primary session, adding version/draft and reference counts without returning
file contents. The default repository-list projection remains unchanged.
`DELETE /api/repos/:id` requires session authentication, a trusted browser origin,
and the inventory's `updatedAt` and nullable `latestVersionId` in its JSON body.
The Drizzle deletion repeats ownership, snapshot, printer binding, public
listing/approval and cross-repository history checks in the mutation itself;
stale or protected configurations return 409, and foreign/missing IDs return 404.
Migration `0030` indexes history lineage for these guards and FK checks.
FK cascades remove drafts, versions, sync tokens and normalized references.
Diagnostic object keys are captured in the same guarded D1 batch before their
rows cascade, then those private objects are removed after the commit. No
printer API, filesystem, apply or restart command is involved.

Deletion frees a repository slot immediately. It does not erase shared canonical
R2 file bodies or release their cumulative byte claims. Existing reference,
lease and fenced reclamation rules still govern those bodies; legacy snapshot
objects likewise remain subject to operator storage reconciliation. Independent
browser drafts, backups and package copies are outside this deletion's scope.

Private-package deletion is available under **Shared Configs → Private packages**.
`GET /api/private-packages?manage=1` returns owner-only metadata and binding/public
snapshot counts from the primary without loading file bodies or definitions.
`DELETE /api/private-packages/:id` requires session authentication, a trusted
origin and the inventory's `updatedAt`. Its Drizzle mutation rechecks the owner,
exact source manifest, update time and current printer bindings. Missing/foreign
IDs return 404; changed or bound packages return 409. A successful deletion frees
one private-package slot and cascades only its private canonical references.
Shared bodies, leases, byte claims, companion assets and independent public
snapshots retain their existing lifecycles. This does not unpublish content or
change printer files or saved configuration history.

Printer saves fence private source IDs read during validation inside their atomic
write, including related scrubs and repository-unbind statements. A source deleted
before that write causes a conflict; a bind committed first protects the private
package from deletion. The existing bind-before-package-save workflow remains
supported. Public listing edits retain their independent owner authorization and
cannot recreate a private source deleted during an in-flight metadata edit.
Confirmed deletion also removes the browser's cached private copy; uncertain
responses are reconciled against a fresh primary inventory before updating it.

Hosted companion assets use `DELETE /api/companion-assets/:id`, with session
authentication, a trusted origin and the editor's `updatedAt`. The Drizzle DELETE
rechecks ownership, the exact source JSON, update time and private-package
attachments atomically. Foreign/missing sources return the same 404; stale or
attached sources return 409. Legacy printer association is organisational metadata
and does not prevent deletion. Independent public profiles, their configuration
links, package publication snapshots and native Orca setup/library data remain.
Private asset content is inline D1 data, so no R2 or printer operation is needed.

The preset editor clears its local copy, stale local attachment IDs and editor
selection only after a matching success receipt or an authoritative missing-source
response. Failed/uncertain requests preserve local state. Private asset list/detail
reads use the primary to prevent a deleted source reappearing on reload. Queued and
active saves/publications block local deletion; existing-source saves cannot
recreate a source deleted after validation. Package saves fence any existing
attachment sources they consulted, while preserving the pre-save attachment
workflow for local-only assets. Deletion immediately frees one asset quota slot.

Before any `blobs/sha256/*` write, D1 atomically claims each distinct content
hash for the owner and for the service. A hash is charged once per owner and
once globally; repeating identical content is free. Each object has a 64 KiB
minimum charge, which bounds both bytes and tiny-object count. The owner budget
is 512 MiB and the service budget for canonical v2 bodies is 20 GiB. Migration
`0021` backfills current referenced v2 manifests, maintains constant-time
aggregate counters, and marks those backfilled bodies as already stored.
Migration `0022` adds source-FK reference tables, an independent raw-manifest
view, write leases, deletion candidates, and audit events. A per-hash
`CANONICAL_BLOB_RECLAIMER` Durable Object serializes the R2 delete and guarded
D1 finalization, so overlapping applies or resumes cannot act on the same stale
object snapshot. New bodies remain pending until their conditional R2 write
succeeds; deduplicated saves skip the R2 write but still take a short D1 lease
until their manifest reference commits.

Legacy v1 whole-snapshot objects use repository-scoped R2 keys, not the shared
v2 namespace. They are finite pre-ledger storage and are deliberately not
folded into a hash-deduplicated counter that would undercount their physical
objects. The 20 GiB figure is therefore a capacity ceiling for canonical v2
writes, not proof that the entire bucket is below 20 GiB. Production rollout
must inventory/reconcile existing R2 objects separately.

The browser uses owner-scoped IndexedDB metadata with shared content bodies.
History reads can return file manifests and a single body table instead of
repeating file text for every version; request-local R2 reads are shared too.
Cloud app-state normalizes repeated draft text inside its bounded snapshot.
See [browser and history storage](browser-storage.md) for the migration,
compatibility, and persistence failure model.

The printer owns `applied_version_id` and `applied_at`. Browser printer-profile
writes cannot set either value. There is no separate known-good pin: the last
physical apply or capture is the one authoritative installed/applied record.
`public_packages.printer_id` identifies the physical source of a linked
publication, while `public_packages.approved_version_id` records which applied
repository version published manually or through an opted-in automatic update. The approval field is
publication provenance, not another known-good or installed-state pointer;
`public_packages.package_json` remains the authoritative anonymous snapshot.

Legacy linked listings keep serving their existing stored snapshot with a null
approval field. The owner must republish or enable automatic updates to establish approved-version
provenance. Rebinding or deleting a printer also keeps the approved stored
snapshot but clears its printer, repository, and approval provenance.

### R2

R2 stores immutable config-file bodies and uploaded raw diagnostic bundles.

R2 objects should be content-addressed where practical:

```text
blobs/sha256/<hash>
snapshots/<package-id>/<version-id>.tar.zst
imports/<user-id>/<upload-id>
```

Rendered ZIP downloads are generated for the response and are not persisted.
This keeps caller-supplied render values out of shared storage and prevents an
anonymous download from creating durable objects. Responses report:

```text
x-klippee-artifact-storage: skipped
x-klippee-artifact-storage-reason: ephemeral-download
```

Deployments before this policy stored generated ZIPs under
`artifacts/rendered-zips/`. The scheduled Worker continues to reap those legacy
objects past their recorded expiry, and legacy objects without expiry metadata
once their upload age passes 90 days. They are not a package source of truth.
Never apply that cleanup policy to immutable `blobs/*` or version snapshots.

Scheduled retention tasks run sequentially to avoid increasing D1/R2 pressure.
Each task is bounded and logged independently; a failure is recorded, later
tasks are still attempted, and the overall tracked promise rejects after the
run so Cloudflare Cron Past Events cannot report a partially failed run as
healthy.

The `blobs/sha256/*` namespace is shared and content-addressed across repository
versions and package snapshots. It must not receive an age-only lifecycle rule:
an old object can still be referenced by a current configuration owned by any
user. Normal version or package deletion does not release a cumulative claim.
The operator workflow in `docs/r2-reclamation.md` uses a seven-day candidate
grace, normalized and raw-manifest checks, an in-flight write lease, and a
durable deletion fence. Owner and service claims are released only after R2
confirms the physical canonical object absent.

Printer diagnostics use a fixed-length hash of the owner/printer scope in their
keys, so even historical identifiers cannot create invalid R2 keys or metadata.
Deleting a printer first revokes its printer-bound tokens, drains existing
diagnostic objects, and makes an in-flight upload re-check the token before its
final D1 insert. If that check fails, the upload deletes the object it just
wrote. Prefix-scoped R2 lifecycle rules remain useful defense in depth for
transient failures; they must never be widened to `blobs/`.

### KV or Cache

KV is optional for the MVP. It can later hold denormalized public package search
records, popular package summaries, or feature flags.

## Request Shape

Initial API groups:

```text
GET    /api/auth/me
POST   /api/auth/logout
GET    /api/auth/github/start
GET    /api/auth/github/callback
GET    /api/auth/discord/start
GET    /api/auth/discord/callback

GET    /api/packages
POST   /api/packages
GET    /api/packages/:owner/:name
POST   /api/packages/:owner/:name/versions
GET    /api/packages/:owner/:name/versions/:version
GET    /api/packages/:owner/:name/versions/:version/files/*
POST   /api/packages/:owner/:name/versions/:version/render-plan
POST   /api/packages/:owner/:name/versions/:version/render-preview
POST   /api/packages/:owner/:name/versions/:version/download.zip

GET    /api/private-packages
POST   /api/private-packages
GET    /api/private-packages/:id
POST   /api/public-packages
PATCH  /api/public-packages/:id
GET    /api/public-packages/:id/status
GET    /api/printers/:id/publication-candidate

GET    /api/companion-assets
POST   /api/companion-assets
GET    /api/companion-assets/:id
POST   /api/companion-assets/:id/publish
GET    /api/public-companion-assets/:slug

GET    /api/private/printers
POST   /api/private/printers
GET    /api/private/printers/:id/variables
PUT    /api/private/printers/:id/variables/:name
POST   /api/private/printers/:id/snapshots
GET    /api/private/printers/:id/snapshots/:version

GET    /api/repos/:id/versions
PUT    /api/repos/:id/pending
GET    /api/repos/:id/sync-status
GET    /api/repos/:id/diff
POST   /api/repos/:id/restore-file
POST   /api/repos/:id/forks

GET    /api/sync/repos/:id/pull
GET    /api/sync/repos/:id/status.txt
GET    /api/sync/repos/:id/snapshot.sh
POST   /api/sync/repos/:id/push
POST   /api/sync/repos/:id/applied
POST   /api/sync/repos/:id/rollback
```

The browser `PUT /pending` path writes only the mutable draft and requires the
browser's saved `baseRevision`. Its D1 update compares both the pending manifest
and immutable-version pointer, so a restored browser tab cannot overwrite a
newer VSCode or desktop draft. The physical printer's `/push` capture and
`/applied` acknowledgement are the only normal paths that advance applied
state. Desktop `/push` is identified by its scoped token, requires the same
kind of matching baseline revision, and stages pending files only.

Render endpoints accept variable values in the request body. They should not
persist those values unless the user explicitly saves them to a private printer
profile.

## Versioning Model

Each package version is an immutable manifest of files and metadata. File
contents are addressed by SHA-256 so duplicate files across packages and
versions can be stored once.

Package file blobs are stored in their template form. Values such as Beacon USB
serial paths are represented as placeholders in the canonical package and are
rendered only when deploying to a specific printer.

Generated zip downloads are deployment artifacts. They should include rendered
config files, a render summary, package metadata, and unresolved warning details.
They should not replace the immutable package version.

A mutable package points to immutable versions:

```text
package qidi/x-plus-4-beacon-box
  latest -> version 2026.04.21
  versions:
    2026.04.21
    2026.04.18
    2026.04.17
```

Private repositories combine a mutable pending draft with a linear immutable
history. The applied pointer is independent of whichever target is newest:

```text
repo tim/x-plus-4
  pending -> revision sha256:9f... "Web editor draft"
  latest immutable -> version 12
  versions:
    12 previous 11 "Installed on Workshop QIDI"
    11 previous 10 "Import printer config"

printer Workshop QIDI
  applied -> version 11 at 2026-08-03T11:42:00Z
```

In this example the pending draft and version 12 are not evidence of what the
printer is using. Only the printer's applied pointer is. A successful physical
apply may advance it to an existing immutable version or create a new version
from the exact canonical snapshot used for the apply. A physical capture also
creates a version and advances it. Desktop capture only replaces the pending
draft after its saved baseline revision still matches the server.

This is intentionally smaller than Git: immutable versions, one previous-version
link, file trees, content-addressed blobs, diffs, rollback, and fork-from-version.
Branches are not part of the MVP.

## Trust Model

Klippee should assume raw printer configs can contain sensitive or unsafe data.
Before a package can become public, it should pass a safety scan or display
clear warnings.

Private packages may preserve sensitive files, but public publishing should
require explicit review for any risky file or field. Linked public workspace
listings snapshot only publishable files from the explicitly selected printer's
current applied version when the owner publishes, republishes, or enables
automatic updates for physical applies and captures. The browser
reviews that exact candidate and submits its immutable version ID; the Worker
rejects the publication if the printer's applied pointer changed in the
meantime. Pending drafts,
later unapproved applied revisions, local variables, credentials, backups, and
other private-only paths remain excluded. A linked listing cannot be published
until that printer has confirmed at least one applied configuration, and a
printer-bound sync token cannot advance public content.
