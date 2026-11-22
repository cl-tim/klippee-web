-- A physical printer is an optional association, never the owner of profiles.
CREATE TABLE orca_capture_grants_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);
INSERT INTO orca_capture_grants_new SELECT * FROM orca_capture_grants;
DROP TABLE orca_capture_grants;
ALTER TABLE orca_capture_grants_new RENAME TO orca_capture_grants;
CREATE INDEX idx_orca_capture_grants_user ON orca_capture_grants(user_id, expires_at);
ALTER TABLE orca_capture_grants ADD COLUMN scope TEXT NOT NULL DEFAULT 'setup';

CREATE TABLE orca_setups_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
  summary_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO orca_setups_new SELECT * FROM orca_setups;
DROP TABLE orca_setups;
ALTER TABLE orca_setups_new RENAME TO orca_setups;
CREATE INDEX idx_orca_setups_printer ON orca_setups(user_id, printer_id, created_at);

CREATE TABLE orca_library_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_orca_library_imports_user ON orca_library_imports(user_id, created_at);
CREATE TABLE orca_library_nodes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_json TEXT NOT NULL,
  PRIMARY KEY (user_id, node_id)
);
CREATE TABLE orca_libraries (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  current_json TEXT NOT NULL
);
CREATE TABLE orca_profile_printers (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, profile_id, printer_id)
);
