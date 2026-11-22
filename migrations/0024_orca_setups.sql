-- Create-only, printer-scoped capture grants. Raw bearer codes are never stored.
CREATE TABLE orca_capture_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_orca_capture_grants_user ON orca_capture_grants(user_id, expires_at);

CREATE TABLE orca_setups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  summary_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_orca_setups_printer ON orca_setups(user_id, printer_id, created_at);
