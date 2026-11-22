-- Migration number: 0003 	 2026-05-13T00:30:00.000Z

CREATE TABLE IF NOT EXISTS user_app_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
