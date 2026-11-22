CREATE TABLE IF NOT EXISTS public_packages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_package_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  package_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_packages_user_id
ON public_packages(user_id);

CREATE INDEX IF NOT EXISTS idx_public_packages_updated_at
ON public_packages(updated_at);
