-- Migration number: 0015 	 2026-07-24T00:00:00.000Z

CREATE TABLE IF NOT EXISTS log_improvement_submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_file_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  original_size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  redaction_confirmed INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_improvement_submissions_user_created
ON log_improvement_submissions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_log_improvement_submissions_expires
ON log_improvement_submissions(expires_at);
