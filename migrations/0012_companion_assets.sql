CREATE TABLE IF NOT EXISTS companion_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('slicer', 'filament')),
  title TEXT NOT NULL,
  asset_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_companion_assets_user_id
ON companion_assets(user_id);

CREATE INDEX IF NOT EXISTS idx_companion_assets_updated_at
ON companion_assets(updated_at);

CREATE TABLE IF NOT EXISTS public_companion_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('slicer', 'filament')),
  title TEXT NOT NULL,
  asset_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (user_id, source_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_public_companion_assets_user_id
ON public_companion_assets(user_id);

CREATE INDEX IF NOT EXISTS idx_public_companion_assets_source_asset_id
ON public_companion_assets(source_asset_id);

CREATE INDEX IF NOT EXISTS idx_public_companion_assets_updated_at
ON public_companion_assets(updated_at);
