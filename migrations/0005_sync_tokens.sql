-- Migration number: 0005 	 2026-05-13T03:00:00.000Z

CREATE TABLE IF NOT EXISTS sync_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_tokens_repository_id
ON sync_tokens(repository_id);

CREATE INDEX IF NOT EXISTS idx_sync_tokens_user_id
ON sync_tokens(user_id);
