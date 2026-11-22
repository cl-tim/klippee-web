# R2 Inventory and Canonical Blob Reclamation

Klippee's canonical `blobs/sha256/*` objects are shared across repository
versions, private packages, public snapshots, and owners. Never delete them from
an age-only lifecycle rule or directly from an R2 listing. Use the protected
inventory and reclamation workflow below.

## Safety model

Migration `0022_canonical_blob_reclamation.sql` adds normalized references for
all four retained manifest sources, an independent JSON-derived reference view,
short-lived write leases, deletion candidates, and a durable audit log.
A `CANONICAL_BLOB_RECLAIMER` Durable Object coordinates each hash so two apply
or resume requests cannot overlap their R2 deletion windows.

A save acquires a D1 lease before it touches R2. Its manifest reference and
lease release commit in one D1 transaction. A deletion candidate must then pass
all of these gates:

1. no normalized reference;
2. no independently derived manifest reference;
3. no unexpired write lease;
4. the same object has remained a candidate for seven days;
5. an atomic D1 deletion fence still sees no references or lease;
6. R2 metadata is unchanged after the fence;
7. R2 confirms the object absent after deletion.

Only the final token-guarded D1 transaction removes owner claims and the global
canonical row. Their triggers release user and service budget totals at that
point. A failure after the fence leaves the fence and claims in place for
explicit recovery; it never times out automatically.

## Configure operator access

Generate a dedicated high-entropy value that is not reused for sessions, OAuth,
or log review, then configure the Worker:

```bash
npx wrangler secret put STORAGE_MAINTENANCE_TOKEN
```

Set the same value only in the operator shell as
`KLIPPEE_STORAGE_MAINTENANCE_TOKEN`. Set `KLIPPEE_ORIGIN` to your deployed
instance or pass `--origin` to the inventory command. Inventory reports contain
private object keys and active recovery tokens. The default filename is ignored by Git;
store them with operator records, restrict access, and never commit them.

## Inventory and dry-run

Run a pure, read-only inventory when first reconciling a deployment:

```bash
npm run storage:inventory -- --inventory-only --output storage-inventory-initial.json
```

The report inventories every R2 page and groups object count and bytes by:

- valid and malformed `blobs/sha256/` keys;
- legacy `repositories/*/versions/sha256/*.json` snapshots;
- `diagnostics/` and `diagnostic-improvements/`;
- legacy `artifacts/rendered-zips/`;
- `snapshots/`, `imports/`, and unknown keys.

It separately reports missing referenced canonical objects, physical canonical
orphans, D1 rows missing from R2, malformed non-reclaimable ledger hashes,
claim-only or lease-only accounting drift, normalized/raw source-identity
drift, referenced or missing legacy v1 snapshots, and unreferenced legacy
objects. Legacy v1 data is report-only; this tool does not delete it.

The normal default is a non-deleting mark/dry-run. It records first-seen
canonical candidates and returns their grace status:

```bash
npm run storage:inventory -- --output storage-inventory-dry-run.json
```

A new reference or write lease cancels an unclaimed candidate. Metadata changes
restart its grace period. Run another dry-run after seven days and review the
saved diff before applying anything.

## Apply a reviewed reclamation

Apply is deliberately noisy and bounded to ten hashes per API request:

```bash
npm run storage:inventory -- \
  --apply \
  --confirm RECLAIM-CANONICAL-BLOBS \
  --output storage-inventory-applied.json
```

The tool rescans production rather than deleting from an old report. Ineligible,
referenced, leased, changed, and still-observing candidates remain untouched.
Afterward, rerun `--inventory-only` and retain both reports with the deployment
record. `canonical_blob_gc_events` is the durable D1 audit trail.

## Interrupted apply recovery

An interrupted request can leave `delete_token` set. This is intentional: it
blocks a replacement writer while R2/D1 completion is uncertain.

1. Stop new reclamation commands and confirm no previous apply process or HTTP
   request is still running. The per-hash coordinator serializes accidental
   overlap, but do not deliberately queue two resumes for the same token.
2. Run `--inventory-only` and inspect `reclaims.candidates`,
   `reclaims.events`, `last_error`, object metadata, and the token's start time.
3. Do not manually clear the candidate or delete claims. A stale deleter could
   otherwise delete a replacement object.
4. When the previous request is definitively dead, resume with the same token:

   ```bash
   npm run storage:inventory -- \
     --apply --resume \
     --confirm RECLAIM-CANONICAL-BLOBS \
     --output storage-inventory-resumed.json
   ```

The resume rechecks R2 metadata, normalized references, raw manifests, and live
leases. If the object is already absent it completes only the guarded D1 claim
release. If metadata changed or deletion cannot be confirmed, it retains the
fence and records the new error for investigation.

## Missing referenced objects

Never resolve a `missingReferenced` finding by deleting its D1 source or claim.
Restore the exact content from a retained printer/config backup and verify its
SHA-256 before writing the canonical key directly, then rerun the read-only
inventory:

```bash
KLIPPEE_R2_BUCKET=klippee-example-blobs  # Use the bucket bound as BLOBS.
HASH="$(sha256sum recovered-file | awk '{print $1}')"
npx wrangler r2 object put \
  "$KLIPPEE_R2_BUCKET/blobs/sha256/$HASH" \
  --remote --file recovered-file
```

A normal Klippee save intentionally trusts a non-null canonical `stored_at`
ledger value and does not issue an R2 read, so it cannot repair a backfilled
missing object by itself. If the bytes cannot be recovered, preserve the
inventory and audit evidence and repair the affected source with the owner
explicitly.

The maintenance endpoints are bearer-token APIs under
`/api/internal/storage/*`; they are not user/session-authorized. Rotate the
maintenance token after operator turnover or suspected report/token exposure.
