-- Migration number: 0021 	 2026-08-04T04:00:00.000Z

-- Canonical v2 config bodies are immutable and shared across owners. These
-- ledgers account for every content hash before R2 is written, so unique
-- overwrite/delete churn remains bounded before reference-aware GC exists.
CREATE TABLE IF NOT EXISTS canonical_blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  charge_bytes INTEGER NOT NULL CHECK (charge_bytes >= 65536 AND charge_bytes >= size_bytes),
  created_at TEXT NOT NULL,
  stored_at TEXT
);

CREATE TABLE IF NOT EXISTS user_blob_claims (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  charge_bytes INTEGER NOT NULL CHECK (charge_bytes >= 65536 AND charge_bytes >= size_bytes),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, sha256)
);

-- Totals are maintained by triggers so reservations read O(1) usage instead
-- of scanning ledgers that can contain hundreds of thousands of rows.
CREATE TABLE IF NOT EXISTS canonical_blob_budget_total (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  charge_bytes INTEGER NOT NULL CHECK (charge_bytes >= 0)
);

INSERT OR IGNORE INTO canonical_blob_budget_total (id, charge_bytes) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS user_blob_budget_totals (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  charge_bytes INTEGER NOT NULL CHECK (charge_bytes >= 0)
);

-- A reservation exists only inside one D1 batch transaction. Its status makes
-- user and service capacity all-or-nothing without relying on no-op INSERTs to
-- roll back earlier writes.
CREATE TABLE IF NOT EXISTS canonical_blob_budget_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'service', 'user')),
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS canonical_blob_charge_insert
AFTER INSERT ON canonical_blobs
BEGIN
  UPDATE canonical_blob_budget_total
  SET charge_bytes = charge_bytes + NEW.charge_bytes
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS canonical_blob_charge_delete
AFTER DELETE ON canonical_blobs
BEGIN
  UPDATE canonical_blob_budget_total
  SET charge_bytes = charge_bytes - OLD.charge_bytes
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS user_blob_claim_charge_insert
AFTER INSERT ON user_blob_claims
BEGIN
  INSERT INTO user_blob_budget_totals (user_id, charge_bytes)
  VALUES (NEW.user_id, NEW.charge_bytes)
  ON CONFLICT(user_id) DO UPDATE SET
    charge_bytes = user_blob_budget_totals.charge_bytes + excluded.charge_bytes;
END;

CREATE TRIGGER IF NOT EXISTS user_blob_claim_charge_delete
AFTER DELETE ON user_blob_claims
BEGIN
  UPDATE user_blob_budget_totals
  SET charge_bytes = charge_bytes - OLD.charge_bytes
  WHERE user_id = OLD.user_id;

  DELETE FROM user_blob_budget_totals
  WHERE user_id = OLD.user_id AND charge_bytes = 0;
END;

-- Parse retained references once. Every JSON argument below is normalized to
-- valid JSON before extraction, so a damaged historical row cannot abort the
-- deployment migration. Scalar/corrupt entries are ignored.
DROP TABLE IF EXISTS canonical_blob_backfill_0021;

CREATE TABLE canonical_blob_backfill_0021 (
  user_id TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER
);

INSERT INTO canonical_blob_backfill_0021 (user_id, sha256, size_bytes)
SELECT versions.user_id,
       json_extract(CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END, '$.sha256'),
       CAST(json_extract(CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END, '$.byteLength') AS INTEGER)
FROM (
  SELECT repositories.user_id,
         CASE WHEN json_valid(repository_versions.files_json)
           THEN repository_versions.files_json ELSE '{}' END AS manifest_json
  FROM repositories
  JOIN repository_versions ON repository_versions.repository_id = repositories.id
) AS versions
JOIN json_each(versions.manifest_json, '$.entries') AS entry
WHERE json_extract(versions.manifest_json, '$.storage') = 'r2-blobs'
  AND json_extract(versions.manifest_json, '$.version') = 2

UNION ALL

SELECT pending.user_id,
       json_extract(CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END, '$.sha256'),
       CAST(json_extract(CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END, '$.byteLength') AS INTEGER)
FROM (
  SELECT repositories.user_id,
         CASE WHEN json_valid(repositories.pending_files_json)
           THEN repositories.pending_files_json ELSE '{}' END AS manifest_json
  FROM repositories
) AS pending
JOIN json_each(pending.manifest_json, '$.entries') AS entry
WHERE json_extract(pending.manifest_json, '$.storage') = 'r2-blobs'
  AND json_extract(pending.manifest_json, '$.version') = 2

UNION ALL

SELECT private_bodies.user_id,
       json_extract(CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END, '$.sha256'),
       CAST(json_extract(CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END, '$.byteLength') AS INTEGER)
FROM (
  SELECT private_packages.user_id,
         safe_bodies.body_json,
         CASE WHEN json_valid(json_extract(safe_bodies.body_json, '$.filesManifest'))
           THEN json_extract(safe_bodies.body_json, '$.filesManifest') ELSE '{}' END AS manifest_json
  FROM private_packages
  JOIN (
    SELECT id,
           CASE WHEN json_valid(package_json) THEN package_json ELSE '{}' END AS body_json
    FROM private_packages
  ) AS safe_bodies ON safe_bodies.id = private_packages.id
) AS private_bodies
JOIN json_each(private_bodies.manifest_json, '$.entries') AS entry
WHERE json_extract(private_bodies.body_json, '$.bodyStorage') = 'r2-blobs'
  AND json_extract(private_bodies.body_json, '$.bodyVersion') = 2
  AND json_extract(private_bodies.manifest_json, '$.storage') = 'r2-blobs'
  AND json_extract(private_bodies.manifest_json, '$.version') = 2

UNION ALL

SELECT public_bodies.user_id,
       json_extract(CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END, '$.sha256'),
       CAST(json_extract(CASE WHEN entry.type = 'object' THEN entry.value ELSE '{}' END, '$.byteLength') AS INTEGER)
FROM (
  SELECT public_packages.user_id,
         safe_bodies.body_json,
         CASE WHEN json_valid(json_extract(safe_bodies.body_json, '$.filesManifest'))
           THEN json_extract(safe_bodies.body_json, '$.filesManifest') ELSE '{}' END AS manifest_json
  FROM public_packages
  JOIN (
    SELECT id,
           CASE WHEN json_valid(package_json) THEN package_json ELSE '{}' END AS body_json
    FROM public_packages
  ) AS safe_bodies ON safe_bodies.id = public_packages.id
) AS public_bodies
JOIN json_each(public_bodies.manifest_json, '$.entries') AS entry
WHERE json_extract(public_bodies.body_json, '$.bodyStorage') = 'r2-blobs'
  AND json_extract(public_bodies.body_json, '$.bodyVersion') = 2
  AND json_extract(public_bodies.manifest_json, '$.storage') = 'r2-blobs'
  AND json_extract(public_bodies.manifest_json, '$.version') = 2;

INSERT INTO canonical_blobs (sha256, size_bytes, charge_bytes, created_at, stored_at)
SELECT sha256,
       MAX(size_bytes),
       CASE WHEN MAX(size_bytes) < 65536 THEN 65536 ELSE MAX(size_bytes) END,
       '2026-08-04T04:00:00.000Z',
       '2026-08-04T04:00:00.000Z'
FROM canonical_blob_backfill_0021
WHERE typeof(sha256) = 'text'
  AND length(sha256) = 64
  AND size_bytes >= 0
GROUP BY sha256
ON CONFLICT(sha256) DO NOTHING;

INSERT INTO user_blob_claims (user_id, sha256, size_bytes, charge_bytes, created_at)
SELECT user_id,
       sha256,
       MAX(size_bytes),
       CASE WHEN MAX(size_bytes) < 65536 THEN 65536 ELSE MAX(size_bytes) END,
       '2026-08-04T04:00:00.000Z'
FROM canonical_blob_backfill_0021
WHERE typeof(user_id) = 'text'
  AND typeof(sha256) = 'text'
  AND length(sha256) = 64
  AND size_bytes >= 0
GROUP BY user_id, sha256
ON CONFLICT(user_id, sha256) DO NOTHING;

DROP TABLE canonical_blob_backfill_0021;
