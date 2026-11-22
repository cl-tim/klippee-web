-- Migration number: 0008 	 2026-05-15T00:00:00.000Z

CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  definition_json TEXT NOT NULL DEFAULT '{}',
  package_ids_json TEXT NOT NULL DEFAULT '[]',
  variable_values_json TEXT NOT NULL DEFAULT '{}',
  repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  latest_version_id INTEGER NOT NULL DEFAULT 0,
  applied_version_id INTEGER NOT NULL DEFAULT 0,
  known_good_version_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_printers_user_id
ON printers(user_id);

CREATE INDEX IF NOT EXISTS idx_printers_repository_id
ON printers(repository_id);
