-- Migration number: 0017 	 2026-07-30T00:00:00.000Z
--
-- Companion assets now store real OrcaSlicer presets, whose `kind` is the preset
-- type (filament | machine | process). Widen the CHECK constraint to allow the
-- new types while keeping the legacy values ('slicer', 'filament') so existing
-- rows survive untouched. SQLite cannot ALTER a CHECK constraint, so each table
-- is recreated in place (create-new → copy → drop → rename → reindex). No other
-- table references these via foreign key, and the new tables re-declare their
-- users(id) FK, so the copy is safe.

CREATE TABLE companion_assets_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('slicer', 'filament', 'machine', 'process')),
  title TEXT NOT NULL,
  asset_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id)
);

INSERT INTO companion_assets_new (id, user_id, kind, title, asset_json, created_at, updated_at)
SELECT id, user_id, kind, title, asset_json, created_at, updated_at FROM companion_assets;

DROP TABLE companion_assets;
ALTER TABLE companion_assets_new RENAME TO companion_assets;

CREATE INDEX IF NOT EXISTS idx_companion_assets_user_id
ON companion_assets(user_id);

CREATE INDEX IF NOT EXISTS idx_companion_assets_updated_at
ON companion_assets(updated_at);

CREATE TABLE public_companion_assets_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('slicer', 'filament', 'machine', 'process')),
  title TEXT NOT NULL,
  asset_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (user_id, source_asset_id)
);

INSERT INTO public_companion_assets_new (id, user_id, source_asset_id, slug, kind, title, asset_json, created_at, updated_at, published_at)
SELECT id, user_id, source_asset_id, slug, kind, title, asset_json, created_at, updated_at, published_at FROM public_companion_assets;

DROP TABLE public_companion_assets;
ALTER TABLE public_companion_assets_new RENAME TO public_companion_assets;

CREATE INDEX IF NOT EXISTS idx_public_companion_assets_user_id
ON public_companion_assets(user_id);

CREATE INDEX IF NOT EXISTS idx_public_companion_assets_source_asset_id
ON public_companion_assets(source_asset_id);

CREATE INDEX IF NOT EXISTS idx_public_companion_assets_updated_at
ON public_companion_assets(updated_at);
