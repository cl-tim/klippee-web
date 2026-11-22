-- Migration number: 0022    2026-08-04T06:00:00.000Z
--
-- Reference-aware reclamation for canonical R2 file bodies.
--
-- D1 and R2 cannot participate in one transaction. The tables and triggers in
-- this migration therefore make D1 the serialization point:
--
--   * source-row triggers maintain a normalized ledger of retained v2 hashes;
--   * an independent JSON view lets inventory/final checks detect ledger drift;
--   * write leases protect the R2-put-to-manifest-commit window;
--   * a claimed GC candidate fences new references and leases; and
--   * durable audit rows survive candidate and canonical-ledger deletion.
--
-- Candidates deliberately have no FK to canonical_blobs. A pre-migration
-- blobs/sha256/* object may exist physically without any D1 row, and must still
-- be fenceable before an operator deletes it.

-- user_blob_claims and user_blob_budget_totals originally cascaded from users.
-- A deleted account could consequently release its charge while the shared R2
-- object still existed. Rebuild both tables without that cascade; reclamation
-- will explicitly remove claims only after R2 absence has been confirmed.
DROP TRIGGER IF EXISTS user_blob_claim_charge_insert;
DROP TRIGGER IF EXISTS user_blob_claim_charge_delete;

DROP TABLE IF EXISTS user_blob_claims_0022;
CREATE TABLE user_blob_claims_0022 (
  user_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  charge_bytes INTEGER NOT NULL CHECK (charge_bytes >= 65536 AND charge_bytes >= size_bytes),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, sha256)
);

INSERT INTO user_blob_claims_0022
  (user_id, sha256, size_bytes, charge_bytes, created_at)
SELECT user_id, sha256, size_bytes, charge_bytes, created_at
FROM user_blob_claims;

DROP TABLE user_blob_claims;
ALTER TABLE user_blob_claims_0022 RENAME TO user_blob_claims;

CREATE INDEX IF NOT EXISTS idx_user_blob_claims_sha256
ON user_blob_claims(sha256);

DROP TABLE IF EXISTS user_blob_budget_totals_0022;
CREATE TABLE user_blob_budget_totals_0022 (
  user_id TEXT PRIMARY KEY,
  charge_bytes INTEGER NOT NULL CHECK (charge_bytes >= 0)
);

-- Recalculate rather than copying the aggregate so rollout also repairs any
-- historical counter drift.
INSERT INTO user_blob_budget_totals_0022 (user_id, charge_bytes)
SELECT user_id, SUM(charge_bytes)
FROM user_blob_claims
GROUP BY user_id;

DROP TABLE user_blob_budget_totals;
ALTER TABLE user_blob_budget_totals_0022 RENAME TO user_blob_budget_totals;

CREATE TRIGGER user_blob_claim_charge_insert
AFTER INSERT ON user_blob_claims
BEGIN
  INSERT INTO user_blob_budget_totals (user_id, charge_bytes)
  VALUES (NEW.user_id, NEW.charge_bytes)
  ON CONFLICT(user_id) DO UPDATE SET
    charge_bytes = user_blob_budget_totals.charge_bytes + excluded.charge_bytes;
END;

CREATE TRIGGER user_blob_claim_charge_delete
AFTER DELETE ON user_blob_claims
BEGIN
  UPDATE user_blob_budget_totals
  SET charge_bytes = charge_bytes - OLD.charge_bytes
  WHERE user_id = OLD.user_id;

  DELETE FROM user_blob_budget_totals
  WHERE user_id = OLD.user_id AND charge_bytes = 0;
END;

-- One row means that the source still retains at least one file with this
-- content hash. Duplicate paths with identical content collapse to one row.
CREATE TABLE IF NOT EXISTS canonical_blob_repository_version_refs (
  version_id TEXT NOT NULL
    REFERENCES repository_versions(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL
    REFERENCES canonical_blobs(sha256) ON DELETE RESTRICT,
  PRIMARY KEY (version_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_repository_version_refs_sha256
ON canonical_blob_repository_version_refs(sha256);

CREATE TABLE IF NOT EXISTS canonical_blob_pending_refs (
  repository_id TEXT NOT NULL
    REFERENCES repositories(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL
    REFERENCES canonical_blobs(sha256) ON DELETE RESTRICT,
  PRIMARY KEY (repository_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_pending_refs_sha256
ON canonical_blob_pending_refs(sha256);

CREATE TABLE IF NOT EXISTS canonical_blob_private_package_refs (
  private_package_id TEXT NOT NULL
    REFERENCES private_packages(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL
    REFERENCES canonical_blobs(sha256) ON DELETE RESTRICT,
  PRIMARY KEY (private_package_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_private_package_refs_sha256
ON canonical_blob_private_package_refs(sha256);

CREATE TABLE IF NOT EXISTS canonical_blob_public_package_refs (
  public_package_id TEXT NOT NULL
    REFERENCES public_packages(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL
    REFERENCES canonical_blobs(sha256) ON DELETE RESTRICT,
  PRIMARY KEY (public_package_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_public_package_refs_sha256
ON canonical_blob_public_package_refs(sha256);

-- A lease spans one logical save and may cover several hashes. It deliberately
-- does not cascade from users: deleting an account must not unprotect an R2 put
-- already in flight. Expired leases remain auditable and are removed explicitly
-- by the operator before final canonical-ledger deletion.
CREATE TABLE IF NOT EXISTS canonical_blob_write_leases (
  lease_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sha256 TEXT NOT NULL
    REFERENCES canonical_blobs(sha256) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (lease_id, sha256),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_write_leases_sha256
ON canonical_blob_write_leases(sha256);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_write_leases_expires
ON canonical_blob_write_leases(expires_at);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_write_leases_user
ON canonical_blob_write_leases(user_id, expires_at);

CREATE TABLE IF NOT EXISTS canonical_blob_gc_candidates (
  r2_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  reclaim_after TEXT NOT NULL,
  object_size_bytes INTEGER CHECK (object_size_bytes IS NULL OR object_size_bytes >= 0),
  object_etag TEXT,
  object_version TEXT,
  object_uploaded_at TEXT,
  delete_token TEXT,
  delete_started_at TEXT,
  last_error TEXT,
  CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (r2_key = 'blobs/sha256/' || sha256),
  CHECK (delete_started_at IS NULL OR delete_token IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_blob_gc_candidates_delete_token
ON canonical_blob_gc_candidates(delete_token)
WHERE delete_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_canonical_blob_gc_candidates_sha256
ON canonical_blob_gc_candidates(sha256);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_gc_candidates_ready
ON canonical_blob_gc_candidates(delete_token, reclaim_after, r2_key);

-- Events do not reference candidate or canonical rows so the audit survives a
-- completed reclamation. The operator records every state transition and can
-- resume an interrupted delete using the candidate's retained delete_token.
CREATE TABLE IF NOT EXISTS canonical_blob_gc_events (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  object_size_bytes INTEGER CHECK (object_size_bytes IS NULL OR object_size_bytes >= 0),
  object_etag TEXT,
  object_version TEXT,
  object_uploaded_at TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT,
  error TEXT,
  CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (r2_key = 'blobs/sha256/' || sha256)
);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_gc_events_r2_key
ON canonical_blob_gc_events(r2_key, started_at);

CREATE INDEX IF NOT EXISTS idx_canonical_blob_gc_events_incomplete
ON canonical_blob_gc_events(completed_at, started_at);

-- This view reparses retained source manifests independently of the normalized
-- tables. It is intentionally safe around malformed historical JSON and is the
-- final guard against migration or trigger drift. Only syntactically valid,
-- lowercase SHA-256 values are canonical references; invalid entries remain an
-- inventory anomaly but can never identify a valid blobs/sha256/* key.
DROP VIEW IF EXISTS canonical_blob_manifest_references;
CREATE VIEW canonical_blob_manifest_references (
  source_type,
  source_id,
  user_id,
  sha256,
  size_bytes
) AS
WITH
repository_version_manifests AS MATERIALIZED (
  SELECT 'repository_version' AS source_type,
         repository_versions.id AS source_id,
         repositories.user_id,
         CASE
           WHEN json_valid(repository_versions.files_json)
             THEN repository_versions.files_json
           ELSE '{}'
         END AS manifest_json
  FROM repository_versions
  JOIN repositories ON repositories.id = repository_versions.repository_id
),
repository_pending_manifests AS MATERIALIZED (
  SELECT 'repository_pending' AS source_type,
         repositories.id AS source_id,
         repositories.user_id,
         CASE
           WHEN json_valid(repositories.pending_files_json)
             THEN repositories.pending_files_json
           ELSE '{}'
         END AS manifest_json
  FROM repositories
),
private_package_bodies AS MATERIALIZED (
  SELECT private_packages.id AS source_id,
         private_packages.user_id,
         CASE
           WHEN json_valid(private_packages.package_json)
             THEN private_packages.package_json
           ELSE '{}'
         END AS body_json
  FROM private_packages
),
private_package_manifests AS MATERIALIZED (
  SELECT 'private_package' AS source_type,
         source_id,
         user_id,
         body_json,
         CASE
           WHEN json_type(body_json, '$.filesManifest') = 'text'
             AND json_valid(json_extract(body_json, '$.filesManifest'))
             THEN json_extract(body_json, '$.filesManifest')
           ELSE '{}'
         END AS manifest_json
  FROM private_package_bodies
),
public_package_bodies AS MATERIALIZED (
  SELECT public_packages.id AS source_id,
         public_packages.user_id,
         CASE
           WHEN json_valid(public_packages.package_json)
             THEN public_packages.package_json
           ELSE '{}'
         END AS body_json
  FROM public_packages
),
public_package_manifests AS MATERIALIZED (
  SELECT 'public_package' AS source_type,
         source_id,
         user_id,
         body_json,
         CASE
           WHEN json_type(body_json, '$.filesManifest') = 'text'
             AND json_valid(json_extract(body_json, '$.filesManifest'))
             THEN json_extract(body_json, '$.filesManifest')
           ELSE '{}'
         END AS manifest_json
  FROM public_package_bodies
),
manifest_entries AS MATERIALIZED (
  SELECT source_type,
         source_id,
         user_id,
         entry.type AS entry_type,
         CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END AS entry_json
  FROM repository_version_manifests
  JOIN json_each(repository_version_manifests.manifest_json, '$.entries') AS entry
  WHERE json_extract(repository_version_manifests.manifest_json, '$.storage') = 'r2-blobs'
    AND json_extract(repository_version_manifests.manifest_json, '$.version') = 2

  UNION ALL

  SELECT source_type,
         source_id,
         user_id,
         entry.type AS entry_type,
         CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END AS entry_json
  FROM repository_pending_manifests
  JOIN json_each(repository_pending_manifests.manifest_json, '$.entries') AS entry
  WHERE json_extract(repository_pending_manifests.manifest_json, '$.storage') = 'r2-blobs'
    AND json_extract(repository_pending_manifests.manifest_json, '$.version') = 2

  UNION ALL

  SELECT source_type,
         source_id,
         user_id,
         entry.type AS entry_type,
         CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END AS entry_json
  FROM private_package_manifests
  JOIN json_each(private_package_manifests.manifest_json, '$.entries') AS entry
  WHERE json_extract(private_package_manifests.body_json, '$.bodyStorage') = 'r2-blobs'
    AND json_extract(private_package_manifests.manifest_json, '$.storage') = 'r2-blobs'
    AND json_extract(private_package_manifests.manifest_json, '$.version') = 2

  UNION ALL

  SELECT source_type,
         source_id,
         user_id,
         entry.type AS entry_type,
         CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END AS entry_json
  FROM public_package_manifests
  JOIN json_each(public_package_manifests.manifest_json, '$.entries') AS entry
  WHERE json_extract(public_package_manifests.body_json, '$.bodyStorage') = 'r2-blobs'
    AND json_extract(public_package_manifests.manifest_json, '$.storage') = 'r2-blobs'
    AND json_extract(public_package_manifests.manifest_json, '$.version') = 2
),
extracted AS (
  SELECT source_type,
         source_id,
         user_id,
         json_extract(entry_json, '$.sha256') AS sha256,
         CASE
           WHEN typeof(json_extract(entry_json, '$.byteLength')) = 'integer'
             AND json_extract(entry_json, '$.byteLength') >= 0
             THEN CAST(json_extract(entry_json, '$.byteLength') AS INTEGER)
           ELSE NULL
         END AS size_bytes
  FROM manifest_entries
  WHERE entry_type = 'object'
)
SELECT source_type, source_id, user_id, sha256, size_bytes
FROM extracted
WHERE typeof(sha256) = 'text'
  AND length(sha256) = 64
  AND sha256 NOT GLOB '*[^0-9a-f]*';

-- Legacy v1 manifests point at whole-snapshot repository-scoped keys. They are
-- not canonical-v2 budget entries, but inventory and final delete checks still
-- need a safe, paginatable source-of-truth view.
DROP VIEW IF EXISTS legacy_repository_manifest_references;
CREATE VIEW legacy_repository_manifest_references (
  source_type,
  source_id,
  user_id,
  r2_key,
  sha256,
  size_bytes
) AS
WITH
repository_version_manifests AS MATERIALIZED (
  SELECT 'repository_version' AS source_type,
         repository_versions.id AS source_id,
         repositories.user_id,
         CASE
           WHEN json_valid(repository_versions.files_json)
             THEN repository_versions.files_json
           ELSE '{}'
         END AS manifest_json
  FROM repository_versions
  JOIN repositories ON repositories.id = repository_versions.repository_id
),
repository_pending_manifests AS MATERIALIZED (
  SELECT 'repository_pending' AS source_type,
         repositories.id AS source_id,
         repositories.user_id,
         CASE
           WHEN json_valid(repositories.pending_files_json)
             THEN repositories.pending_files_json
           ELSE '{}'
         END AS manifest_json
  FROM repositories
),
private_package_bodies AS MATERIALIZED (
  SELECT private_packages.id AS source_id,
         private_packages.user_id,
         CASE
           WHEN json_valid(private_packages.package_json)
             THEN private_packages.package_json
           ELSE '{}'
         END AS body_json
  FROM private_packages
),
private_package_manifests AS MATERIALIZED (
  SELECT 'private_package' AS source_type,
         source_id,
         user_id,
         body_json,
         CASE
           WHEN json_type(body_json, '$.filesManifest') = 'text'
             AND json_valid(json_extract(body_json, '$.filesManifest'))
             THEN json_extract(body_json, '$.filesManifest')
           ELSE '{}'
         END AS manifest_json
  FROM private_package_bodies
),
public_package_bodies AS MATERIALIZED (
  SELECT public_packages.id AS source_id,
         public_packages.user_id,
         CASE
           WHEN json_valid(public_packages.package_json)
             THEN public_packages.package_json
           ELSE '{}'
         END AS body_json
  FROM public_packages
),
public_package_manifests AS MATERIALIZED (
  SELECT 'public_package' AS source_type,
         source_id,
         user_id,
         body_json,
         CASE
           WHEN json_type(body_json, '$.filesManifest') = 'text'
             AND json_valid(json_extract(body_json, '$.filesManifest'))
             THEN json_extract(body_json, '$.filesManifest')
           ELSE '{}'
         END AS manifest_json
  FROM public_package_bodies
),
legacy_manifests AS (
  SELECT source_type, source_id, user_id, manifest_json
  FROM repository_version_manifests
  WHERE json_extract(manifest_json, '$.storage') = 'r2'
    AND json_extract(manifest_json, '$.version') = 1

  UNION ALL

  SELECT source_type, source_id, user_id, manifest_json
  FROM repository_pending_manifests
  WHERE json_extract(manifest_json, '$.storage') = 'r2'
    AND json_extract(manifest_json, '$.version') = 1

  UNION ALL

  SELECT source_type, source_id, user_id, manifest_json
  FROM private_package_manifests
  WHERE json_extract(body_json, '$.bodyStorage') = 'r2-blobs'
    AND json_extract(manifest_json, '$.storage') = 'r2'
    AND json_extract(manifest_json, '$.version') = 1

  UNION ALL

  SELECT source_type, source_id, user_id, manifest_json
  FROM public_package_manifests
  WHERE json_extract(body_json, '$.bodyStorage') = 'r2-blobs'
    AND json_extract(manifest_json, '$.storage') = 'r2'
    AND json_extract(manifest_json, '$.version') = 1
)
SELECT source_type,
       source_id,
       user_id,
       json_extract(manifest_json, '$.key') AS r2_key,
       CASE
         WHEN typeof(json_extract(manifest_json, '$.sha256')) = 'text'
           THEN json_extract(manifest_json, '$.sha256')
         ELSE NULL
       END AS sha256,
       CASE
         WHEN typeof(json_extract(manifest_json, '$.byteLength')) = 'integer'
           AND json_extract(manifest_json, '$.byteLength') >= 0
           THEN CAST(json_extract(manifest_json, '$.byteLength') AS INTEGER)
         ELSE NULL
       END AS size_bytes
FROM legacy_manifests
WHERE typeof(json_extract(manifest_json, '$.key')) = 'text'
  AND length(json_extract(manifest_json, '$.key')) > 0;

-- Normalized ledger view. Ownership is derived from the FK-backed source row,
-- avoiding a denormalized user id that could drift from the source owner.
DROP VIEW IF EXISTS canonical_blob_references;
CREATE VIEW canonical_blob_references (
  source_type,
  source_id,
  user_id,
  sha256
) AS
SELECT 'repository_version',
       refs.version_id,
       repositories.user_id,
       refs.sha256
FROM canonical_blob_repository_version_refs AS refs
JOIN repository_versions ON repository_versions.id = refs.version_id
JOIN repositories ON repositories.id = repository_versions.repository_id

UNION ALL

SELECT 'repository_pending',
       refs.repository_id,
       repositories.user_id,
       refs.sha256
FROM canonical_blob_pending_refs AS refs
JOIN repositories ON repositories.id = refs.repository_id

UNION ALL

SELECT 'private_package',
       refs.private_package_id,
       private_packages.user_id,
       refs.sha256
FROM canonical_blob_private_package_refs AS refs
JOIN private_packages ON private_packages.id = refs.private_package_id

UNION ALL

SELECT 'public_package',
       refs.public_package_id,
       public_packages.user_id,
       refs.sha256
FROM canonical_blob_public_package_refs AS refs
JOIN public_packages ON public_packages.id = refs.public_package_id;

-- Reference and lease writes are the normal cancellation path for an observed
-- but not-yet-claimed candidate. Once delete_token is set they abort instead,
-- making the D1 transaction that claims a candidate the deletion fence.
DROP TRIGGER IF EXISTS canonical_blob_repository_version_ref_fence_insert;
CREATE TRIGGER canonical_blob_repository_version_ref_fence_insert
BEFORE INSERT ON canonical_blob_repository_version_refs
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_repository_version_ref_fence_update;
CREATE TRIGGER canonical_blob_repository_version_ref_fence_update
BEFORE UPDATE OF sha256 ON canonical_blob_repository_version_refs
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_repository_version_ref_cancel_insert;
CREATE TRIGGER canonical_blob_repository_version_ref_cancel_insert
AFTER INSERT ON canonical_blob_repository_version_refs
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_repository_version_ref_cancel_update;
CREATE TRIGGER canonical_blob_repository_version_ref_cancel_update
AFTER UPDATE OF sha256 ON canonical_blob_repository_version_refs
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_pending_ref_fence_insert;
CREATE TRIGGER canonical_blob_pending_ref_fence_insert
BEFORE INSERT ON canonical_blob_pending_refs
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_pending_ref_fence_update;
CREATE TRIGGER canonical_blob_pending_ref_fence_update
BEFORE UPDATE OF sha256 ON canonical_blob_pending_refs
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_pending_ref_cancel_insert;
CREATE TRIGGER canonical_blob_pending_ref_cancel_insert
AFTER INSERT ON canonical_blob_pending_refs
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_pending_ref_cancel_update;
CREATE TRIGGER canonical_blob_pending_ref_cancel_update
AFTER UPDATE OF sha256 ON canonical_blob_pending_refs
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_private_package_ref_fence_insert;
CREATE TRIGGER canonical_blob_private_package_ref_fence_insert
BEFORE INSERT ON canonical_blob_private_package_refs
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_private_package_ref_fence_update;
CREATE TRIGGER canonical_blob_private_package_ref_fence_update
BEFORE UPDATE OF sha256 ON canonical_blob_private_package_refs
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_private_package_ref_cancel_insert;
CREATE TRIGGER canonical_blob_private_package_ref_cancel_insert
AFTER INSERT ON canonical_blob_private_package_refs
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_private_package_ref_cancel_update;
CREATE TRIGGER canonical_blob_private_package_ref_cancel_update
AFTER UPDATE OF sha256 ON canonical_blob_private_package_refs
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_public_package_ref_fence_insert;
CREATE TRIGGER canonical_blob_public_package_ref_fence_insert
BEFORE INSERT ON canonical_blob_public_package_refs
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_public_package_ref_fence_update;
CREATE TRIGGER canonical_blob_public_package_ref_fence_update
BEFORE UPDATE OF sha256 ON canonical_blob_public_package_refs
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_public_package_ref_cancel_insert;
CREATE TRIGGER canonical_blob_public_package_ref_cancel_insert
AFTER INSERT ON canonical_blob_public_package_refs
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_public_package_ref_cancel_update;
CREATE TRIGGER canonical_blob_public_package_ref_cancel_update
AFTER UPDATE OF sha256 ON canonical_blob_public_package_refs
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_write_lease_fence_insert;
CREATE TRIGGER canonical_blob_write_lease_fence_insert
BEFORE INSERT ON canonical_blob_write_leases
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_write_lease_fence_update;
CREATE TRIGGER canonical_blob_write_lease_fence_update
BEFORE UPDATE OF sha256, expires_at ON canonical_blob_write_leases
WHEN EXISTS (
  SELECT 1 FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'canonical blob reclamation in progress');
END;

DROP TRIGGER IF EXISTS canonical_blob_write_lease_cancel_insert;
CREATE TRIGGER canonical_blob_write_lease_cancel_insert
AFTER INSERT ON canonical_blob_write_leases
WHEN NEW.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

DROP TRIGGER IF EXISTS canonical_blob_write_lease_cancel_update;
CREATE TRIGGER canonical_blob_write_lease_cancel_update
AFTER UPDATE OF sha256, expires_at ON canonical_blob_write_leases
WHEN NEW.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = 'blobs/sha256/' || NEW.sha256
    AND delete_token IS NULL;
END;

-- Refuse to persist a stale candidate if either maintained or raw source state
-- says it is live. RAISE(IGNORE) lets a multi-object planning run skip only the
-- stale row. If an old unclaimed candidate exists, remove it at the same time.
DROP TRIGGER IF EXISTS canonical_blob_gc_candidate_insert_guard;
CREATE TRIGGER canonical_blob_gc_candidate_insert_guard
BEFORE INSERT ON canonical_blob_gc_candidates
WHEN EXISTS (
    SELECT 1 FROM canonical_blob_references
    WHERE 'blobs/sha256/' || sha256 = NEW.r2_key
  )
  OR EXISTS (
    SELECT 1 FROM canonical_blob_manifest_references
    WHERE 'blobs/sha256/' || sha256 = NEW.r2_key
  )
  OR EXISTS (
    SELECT 1 FROM legacy_repository_manifest_references
    WHERE r2_key = NEW.r2_key
  )
  OR EXISTS (
    SELECT 1 FROM canonical_blob_write_leases
    WHERE 'blobs/sha256/' || sha256 = NEW.r2_key
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
BEGIN
  DELETE FROM canonical_blob_gc_candidates
  WHERE r2_key = NEW.r2_key AND delete_token IS NULL;
  SELECT RAISE(IGNORE);
END;

-- Claiming is the final D1 fence. Unlike planning, a stale claim attempt is an
-- error so operator tooling cannot mistake it for permission to touch R2.
DROP TRIGGER IF EXISTS canonical_blob_gc_candidate_claim_guard;
CREATE TRIGGER canonical_blob_gc_candidate_claim_guard
BEFORE UPDATE OF delete_token ON canonical_blob_gc_candidates
WHEN NEW.delete_token IS NOT NULL
  AND OLD.delete_token IS NULL
  AND (
    EXISTS (
      SELECT 1 FROM canonical_blob_references
      WHERE 'blobs/sha256/' || sha256 = NEW.r2_key
    )
    OR EXISTS (
      SELECT 1 FROM canonical_blob_manifest_references
      WHERE 'blobs/sha256/' || sha256 = NEW.r2_key
    )
    OR EXISTS (
      SELECT 1 FROM legacy_repository_manifest_references
      WHERE r2_key = NEW.r2_key
    )
    OR EXISTS (
      SELECT 1 FROM canonical_blob_write_leases
      WHERE 'blobs/sha256/' || sha256 = NEW.r2_key
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'R2 object is referenced or leased');
END;

-- Backfill normalized rows from the independently parsed manifests. Joining
-- canonical_blobs keeps a damaged historical reference from aborting rollout;
-- it remains visible in canonical_blob_manifest_references for reconciliation.
INSERT OR IGNORE INTO canonical_blob_repository_version_refs (version_id, sha256)
SELECT manifest.source_id, manifest.sha256
FROM canonical_blob_manifest_references AS manifest
JOIN canonical_blobs ON canonical_blobs.sha256 = manifest.sha256
WHERE manifest.source_type = 'repository_version';

INSERT OR IGNORE INTO canonical_blob_pending_refs (repository_id, sha256)
SELECT manifest.source_id, manifest.sha256
FROM canonical_blob_manifest_references AS manifest
JOIN canonical_blobs ON canonical_blobs.sha256 = manifest.sha256
WHERE manifest.source_type = 'repository_pending';

INSERT OR IGNORE INTO canonical_blob_private_package_refs (private_package_id, sha256)
SELECT manifest.source_id, manifest.sha256
FROM canonical_blob_manifest_references AS manifest
JOIN canonical_blobs ON canonical_blobs.sha256 = manifest.sha256
WHERE manifest.source_type = 'private_package';

INSERT OR IGNORE INTO canonical_blob_public_package_refs (public_package_id, sha256)
SELECT manifest.source_id, manifest.sha256
FROM canonical_blob_manifest_references AS manifest
JOIN canonical_blobs ON canonical_blobs.sha256 = manifest.sha256
WHERE manifest.source_type = 'public_package';

-- Source maintenance. Hot source writes parse only NEW; the materialized raw
-- views above are reserved for backfill, inventory, and final drift checks.
-- Invalid JSON and primitive entries produce no refs. A ref-table RAISE/FK
-- failure rolls the source statement back together with the ledger changes.
-- Legacy v1 references are report-only and are never canonical GC candidates.
DROP TRIGGER IF EXISTS canonical_blob_repository_version_refs_insert;
CREATE TRIGGER canonical_blob_repository_version_refs_insert
AFTER INSERT ON repository_versions
BEGIN
  INSERT OR IGNORE INTO canonical_blob_repository_version_refs (version_id, sha256)
  SELECT NEW.id, parsed.sha256
  FROM (
    SELECT CASE
             WHEN entry.type = 'object' AND json_valid(entry.value)
               THEN json_extract(entry.value, '$.sha256')
             ELSE NULL
           END AS sha256
    FROM json_each(
      CASE WHEN json_valid(NEW.files_json) THEN NEW.files_json ELSE '{}' END,
      '$.entries'
    ) AS entry
    WHERE json_extract(
            CASE WHEN json_valid(NEW.files_json) THEN NEW.files_json ELSE '{}' END,
            '$.storage'
          ) = 'r2-blobs'
      AND json_extract(
            CASE WHEN json_valid(NEW.files_json) THEN NEW.files_json ELSE '{}' END,
            '$.version'
          ) = 2
  ) AS parsed
  WHERE typeof(parsed.sha256) = 'text'
    AND length(parsed.sha256) = 64
    AND parsed.sha256 NOT GLOB '*[^0-9a-f]*';
END;

DROP TRIGGER IF EXISTS canonical_blob_repository_version_refs_update;
CREATE TRIGGER canonical_blob_repository_version_refs_update
AFTER UPDATE OF files_json ON repository_versions
BEGIN
  DELETE FROM canonical_blob_repository_version_refs WHERE version_id = NEW.id;

  INSERT OR IGNORE INTO canonical_blob_repository_version_refs (version_id, sha256)
  SELECT NEW.id, parsed.sha256
  FROM (
    SELECT CASE
             WHEN entry.type = 'object' AND json_valid(entry.value)
               THEN json_extract(entry.value, '$.sha256')
             ELSE NULL
           END AS sha256
    FROM json_each(
      CASE WHEN json_valid(NEW.files_json) THEN NEW.files_json ELSE '{}' END,
      '$.entries'
    ) AS entry
    WHERE json_extract(
            CASE WHEN json_valid(NEW.files_json) THEN NEW.files_json ELSE '{}' END,
            '$.storage'
          ) = 'r2-blobs'
      AND json_extract(
            CASE WHEN json_valid(NEW.files_json) THEN NEW.files_json ELSE '{}' END,
            '$.version'
          ) = 2
  ) AS parsed
  WHERE typeof(parsed.sha256) = 'text'
    AND length(parsed.sha256) = 64
    AND parsed.sha256 NOT GLOB '*[^0-9a-f]*';
END;

DROP TRIGGER IF EXISTS canonical_blob_repository_version_refs_delete;
CREATE TRIGGER canonical_blob_repository_version_refs_delete
AFTER DELETE ON repository_versions
BEGIN
  DELETE FROM canonical_blob_repository_version_refs WHERE version_id = OLD.id;
END;

DROP TRIGGER IF EXISTS canonical_blob_pending_refs_insert;
CREATE TRIGGER canonical_blob_pending_refs_insert
AFTER INSERT ON repositories
BEGIN
  INSERT OR IGNORE INTO canonical_blob_pending_refs (repository_id, sha256)
  SELECT NEW.id, parsed.sha256
  FROM (
    SELECT CASE
             WHEN entry.type = 'object' AND json_valid(entry.value)
               THEN json_extract(entry.value, '$.sha256')
             ELSE NULL
           END AS sha256
    FROM json_each(
      CASE
        WHEN json_valid(NEW.pending_files_json) THEN NEW.pending_files_json
        ELSE '{}'
      END,
      '$.entries'
    ) AS entry
    WHERE json_extract(
            CASE
              WHEN json_valid(NEW.pending_files_json) THEN NEW.pending_files_json
              ELSE '{}'
            END,
            '$.storage'
          ) = 'r2-blobs'
      AND json_extract(
            CASE
              WHEN json_valid(NEW.pending_files_json) THEN NEW.pending_files_json
              ELSE '{}'
            END,
            '$.version'
          ) = 2
  ) AS parsed
  WHERE typeof(parsed.sha256) = 'text'
    AND length(parsed.sha256) = 64
    AND parsed.sha256 NOT GLOB '*[^0-9a-f]*';
END;

DROP TRIGGER IF EXISTS canonical_blob_pending_refs_update;
CREATE TRIGGER canonical_blob_pending_refs_update
AFTER UPDATE OF pending_files_json ON repositories
BEGIN
  DELETE FROM canonical_blob_pending_refs WHERE repository_id = NEW.id;

  INSERT OR IGNORE INTO canonical_blob_pending_refs (repository_id, sha256)
  SELECT NEW.id, parsed.sha256
  FROM (
    SELECT CASE
             WHEN entry.type = 'object' AND json_valid(entry.value)
               THEN json_extract(entry.value, '$.sha256')
             ELSE NULL
           END AS sha256
    FROM json_each(
      CASE
        WHEN json_valid(NEW.pending_files_json) THEN NEW.pending_files_json
        ELSE '{}'
      END,
      '$.entries'
    ) AS entry
    WHERE json_extract(
            CASE
              WHEN json_valid(NEW.pending_files_json) THEN NEW.pending_files_json
              ELSE '{}'
            END,
            '$.storage'
          ) = 'r2-blobs'
      AND json_extract(
            CASE
              WHEN json_valid(NEW.pending_files_json) THEN NEW.pending_files_json
              ELSE '{}'
            END,
            '$.version'
          ) = 2
  ) AS parsed
  WHERE typeof(parsed.sha256) = 'text'
    AND length(parsed.sha256) = 64
    AND parsed.sha256 NOT GLOB '*[^0-9a-f]*';
END;

DROP TRIGGER IF EXISTS canonical_blob_pending_refs_delete;
CREATE TRIGGER canonical_blob_pending_refs_delete
AFTER DELETE ON repositories
BEGIN
  DELETE FROM canonical_blob_pending_refs WHERE repository_id = OLD.id;
END;

DROP TRIGGER IF EXISTS canonical_blob_private_package_refs_insert;
CREATE TRIGGER canonical_blob_private_package_refs_insert
AFTER INSERT ON private_packages
BEGIN
  INSERT OR IGNORE INTO canonical_blob_private_package_refs (private_package_id, sha256)
  SELECT NEW.id, parsed.sha256
  FROM (
    SELECT CASE
             WHEN entry.type = 'object' AND json_valid(entry.value)
               THEN json_extract(entry.value, '$.sha256')
             ELSE NULL
           END AS sha256,
           safe.body_json,
           safe.manifest_json
    FROM (
      SELECT body.body_json,
             CASE
               WHEN json_type(body.body_json, '$.filesManifest') = 'text'
                 AND json_valid(json_extract(body.body_json, '$.filesManifest'))
                 THEN json_extract(body.body_json, '$.filesManifest')
               ELSE '{}'
             END AS manifest_json
      FROM (
        SELECT CASE
                 WHEN json_valid(NEW.package_json) THEN NEW.package_json
                 ELSE '{}'
               END AS body_json
      ) AS body
    ) AS safe
    JOIN json_each(safe.manifest_json, '$.entries') AS entry
  ) AS parsed
  WHERE json_extract(parsed.body_json, '$.bodyStorage') = 'r2-blobs'
    AND json_extract(parsed.manifest_json, '$.storage') = 'r2-blobs'
    AND json_extract(parsed.manifest_json, '$.version') = 2
    AND typeof(parsed.sha256) = 'text'
    AND length(parsed.sha256) = 64
    AND parsed.sha256 NOT GLOB '*[^0-9a-f]*';
END;

DROP TRIGGER IF EXISTS canonical_blob_private_package_refs_update;
CREATE TRIGGER canonical_blob_private_package_refs_update
AFTER UPDATE OF package_json ON private_packages
BEGIN
  DELETE FROM canonical_blob_private_package_refs WHERE private_package_id = NEW.id;

  INSERT OR IGNORE INTO canonical_blob_private_package_refs (private_package_id, sha256)
  SELECT NEW.id, parsed.sha256
  FROM (
    SELECT CASE
             WHEN entry.type = 'object' AND json_valid(entry.value)
               THEN json_extract(entry.value, '$.sha256')
             ELSE NULL
           END AS sha256,
           safe.body_json,
           safe.manifest_json
    FROM (
      SELECT body.body_json,
             CASE
               WHEN json_type(body.body_json, '$.filesManifest') = 'text'
                 AND json_valid(json_extract(body.body_json, '$.filesManifest'))
                 THEN json_extract(body.body_json, '$.filesManifest')
               ELSE '{}'
             END AS manifest_json
      FROM (
        SELECT CASE
                 WHEN json_valid(NEW.package_json) THEN NEW.package_json
                 ELSE '{}'
               END AS body_json
      ) AS body
    ) AS safe
    JOIN json_each(safe.manifest_json, '$.entries') AS entry
  ) AS parsed
  WHERE json_extract(parsed.body_json, '$.bodyStorage') = 'r2-blobs'
    AND json_extract(parsed.manifest_json, '$.storage') = 'r2-blobs'
    AND json_extract(parsed.manifest_json, '$.version') = 2
    AND typeof(parsed.sha256) = 'text'
    AND length(parsed.sha256) = 64
    AND parsed.sha256 NOT GLOB '*[^0-9a-f]*';
END;

DROP TRIGGER IF EXISTS canonical_blob_private_package_refs_delete;
CREATE TRIGGER canonical_blob_private_package_refs_delete
AFTER DELETE ON private_packages
BEGIN
  DELETE FROM canonical_blob_private_package_refs WHERE private_package_id = OLD.id;
END;

DROP TRIGGER IF EXISTS canonical_blob_public_package_refs_insert;
CREATE TRIGGER canonical_blob_public_package_refs_insert
AFTER INSERT ON public_packages
BEGIN
  INSERT OR IGNORE INTO canonical_blob_public_package_refs (public_package_id, sha256)
  SELECT NEW.id, parsed.sha256
  FROM (
    SELECT CASE
             WHEN entry.type = 'object' AND json_valid(entry.value)
               THEN json_extract(entry.value, '$.sha256')
             ELSE NULL
           END AS sha256,
           safe.body_json,
           safe.manifest_json
    FROM (
      SELECT body.body_json,
             CASE
               WHEN json_type(body.body_json, '$.filesManifest') = 'text'
                 AND json_valid(json_extract(body.body_json, '$.filesManifest'))
                 THEN json_extract(body.body_json, '$.filesManifest')
               ELSE '{}'
             END AS manifest_json
      FROM (
        SELECT CASE
                 WHEN json_valid(NEW.package_json) THEN NEW.package_json
                 ELSE '{}'
               END AS body_json
      ) AS body
    ) AS safe
    JOIN json_each(safe.manifest_json, '$.entries') AS entry
  ) AS parsed
  WHERE json_extract(parsed.body_json, '$.bodyStorage') = 'r2-blobs'
    AND json_extract(parsed.manifest_json, '$.storage') = 'r2-blobs'
    AND json_extract(parsed.manifest_json, '$.version') = 2
    AND typeof(parsed.sha256) = 'text'
    AND length(parsed.sha256) = 64
    AND parsed.sha256 NOT GLOB '*[^0-9a-f]*';
END;

DROP TRIGGER IF EXISTS canonical_blob_public_package_refs_update;
CREATE TRIGGER canonical_blob_public_package_refs_update
AFTER UPDATE OF package_json ON public_packages
BEGIN
  DELETE FROM canonical_blob_public_package_refs WHERE public_package_id = NEW.id;

  INSERT OR IGNORE INTO canonical_blob_public_package_refs (public_package_id, sha256)
  SELECT NEW.id, parsed.sha256
  FROM (
    SELECT CASE
             WHEN entry.type = 'object' AND json_valid(entry.value)
               THEN json_extract(entry.value, '$.sha256')
             ELSE NULL
           END AS sha256,
           safe.body_json,
           safe.manifest_json
    FROM (
      SELECT body.body_json,
             CASE
               WHEN json_type(body.body_json, '$.filesManifest') = 'text'
                 AND json_valid(json_extract(body.body_json, '$.filesManifest'))
                 THEN json_extract(body.body_json, '$.filesManifest')
               ELSE '{}'
             END AS manifest_json
      FROM (
        SELECT CASE
                 WHEN json_valid(NEW.package_json) THEN NEW.package_json
                 ELSE '{}'
               END AS body_json
      ) AS body
    ) AS safe
    JOIN json_each(safe.manifest_json, '$.entries') AS entry
  ) AS parsed
  WHERE json_extract(parsed.body_json, '$.bodyStorage') = 'r2-blobs'
    AND json_extract(parsed.manifest_json, '$.storage') = 'r2-blobs'
    AND json_extract(parsed.manifest_json, '$.version') = 2
    AND typeof(parsed.sha256) = 'text'
    AND length(parsed.sha256) = 64
    AND parsed.sha256 NOT GLOB '*[^0-9a-f]*';
END;

DROP TRIGGER IF EXISTS canonical_blob_public_package_refs_delete;
CREATE TRIGGER canonical_blob_public_package_refs_delete
AFTER DELETE ON public_packages
BEGIN
  DELETE FROM canonical_blob_public_package_refs WHERE public_package_id = OLD.id;
END;
