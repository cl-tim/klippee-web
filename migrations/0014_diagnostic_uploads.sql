-- Migration number: 0014 	 2026-07-23T13:00:00.000Z

CREATE TABLE IF NOT EXISTS diagnostic_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  original_size_bytes INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_uploads_user_created
ON diagnostic_uploads(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diagnostic_uploads_printer_created
ON diagnostic_uploads(printer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diagnostic_uploads_expires
ON diagnostic_uploads(expires_at);
