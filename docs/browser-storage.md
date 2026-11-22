# Browser and history storage

Configuration history stores references to shared file bodies. A version still
records its complete file set, timestamp, source, and lineage, but unchanged
file text does not need another stored copy.

## Browser workspace

Account-owned workspace data lives in the `klippee-browser-storage` IndexedDB
database. Metadata identifies an authenticated user or the explicit anonymous
workspace. Content bodies are addressed by SHA-256 within that owner scope.
Histories, printer workspace snapshots, current content, structural drafts,
per-file text drafts, and asset/source content can refer to the same body.
Bodies are never shared across browser account scopes.

The account storage provider hydrates saved data before mounting workspace
state. Callers keep the existing synchronous in-memory interface; durable
writes are queued and commit metadata with their bodies in an IndexedDB
transaction. Replacing metadata reclaims bodies only when no metadata in that
account still references them. Deleting a historical version therefore cannot
remove a body needed by another version or draft.

Storage failures retain the current in-memory edits and surface a warning.
Failed writes remain available to retry. IndexedDB being unavailable must not
fall back to writing large snapshots into localStorage. A memory-only session
explicitly warns that its edits may not survive reload. Closing the page before
pending writes finish can still lose the most recent edits; the interface
reports pending and failed persistence separately from cloud saves.

Writes also compare the revision of every changed metadata key with the
revision that this tab loaded. A stale tab cannot replace a newer tab's saved
draft. Conflicts keep the unsaved edits open and require copying or reconciling
them before reloading; retry does not silently adopt a newer baseline.

## Migration and ownership

Existing account-scoped `klippee.mvp.accounts.*` records are imported into their
original owner scope. Source keys are removed only after their data has been
durably committed; a failed migration retains its source. Data written by an
older open tab during migration must not be silently deleted or replace a
newer durable draft.

Old unscoped `klippee.mvp.*` workspace records have no provable owner. Preserve
them in a separate legacy archive rather than expose them to whichever account
opens the application. Harmless device-wide navigation preferences remain in
localStorage. Migration operates on the browser's saved data and does not
contact a printer, stage configuration, or apply a print configuration.

## Cloud storage and history transfer

New immutable repository versions and package files already use R2 objects at
`blobs/sha256/<hash>`. D1 manifests contain file paths, roles, visibility,
lengths, and hashes. The existing owner checks, write leases, reference
accounting, and guarded reclamation remain authoritative. Legacy inline and
whole-snapshot manifests remain readable; this change does not delete or
rewrite production R2 objects.

The browser requests
`GET /api/repos/:id/versions?format=content-addressed`. The response contains
version and desired-workspace manifests plus a single hash-to-text table.
Within a request, each canonical R2 body is fetched and verified once even when
many versions and the desired workspace reference it. The browser resolves the
manifests into the existing history interface. Older clients can continue to
request the original full-file response.

Cloud app-state uses a versioned content table internally so the same draft
text is not repeated in its stored JSON. Legacy app-state remains readable and
the external plain-state read contract remains compatible. App-state reads
return a revision; saves must supply it as `expectedRevision` (or null to create
the first snapshot). A stale save receives HTTP 409 without replacing the
newer snapshot. Saves from one browser tab are serialized. Older application
builds must reload before saving with the new concurrency contract. Returning
browsers retain their cloud baseline alongside drafts; an unknown or changed
baseline requires reconciliation unless the local and cloud snapshots match.
Host-local variable values are removed before encoding, including from the
body table. Repository
history stays out of app-state because the repository is its authoritative
source. App-state remains a bounded backup for client-only workspace state.

The mutable repository draft remains one bounded inline D1 snapshot, replaced
in place. Creating an immutable R2 object for every editor keystroke would
accumulate abandoned drafts. It is intentionally separate from the immutable
history body store.

## Scope and limits

This design preserves local-only history and offline drafts. A repository
history load still retrieves all retained versions, with each unique body sent
once. It does not introduce lazy or paginated history, discard recovery points,
increase server quotas, or remove legacy R2 snapshots. See
[architecture.md](architecture.md) for cloud limits and
[r2-reclamation.md](r2-reclamation.md) for production storage reconciliation.
