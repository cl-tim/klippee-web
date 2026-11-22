-- Migration number: 0004 	 2026-05-13T01:00:00.000Z

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  latest_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_repositories_user_id
ON repositories(user_id);

CREATE TABLE IF NOT EXISTS repository_versions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  previous_version_id TEXT REFERENCES repository_versions(id),
  message TEXT NOT NULL,
  source TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (repository_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_repository_versions_repository_id
ON repository_versions(repository_id);
