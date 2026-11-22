-- Persistent, read-only library access. Pairing codes remain short-lived.
CREATE TABLE orca_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX idx_orca_devices_user ON orca_devices(user_id);
