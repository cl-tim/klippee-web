-- Migration number: 0006 	 2026-05-13T04:00:00.000Z

CREATE TABLE IF NOT EXISTS private_packages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  package_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, package_id)
);

CREATE INDEX IF NOT EXISTS idx_private_packages_user_id
ON private_packages(user_id);

CREATE INDEX IF NOT EXISTS idx_private_packages_updated_at
ON private_packages(updated_at);
