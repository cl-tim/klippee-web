ALTER TABLE public_companion_assets ADD COLUMN orca_profile_id TEXT;
ALTER TABLE public_companion_assets ADD COLUMN auto_update_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (auto_update_enabled IN (0, 1));
ALTER TABLE public_companion_assets ADD COLUMN auto_update_error TEXT;
ALTER TABLE public_companion_assets ADD COLUMN auto_update_import_id TEXT;
ALTER TABLE public_companion_assets ADD COLUMN printer_config_id TEXT
  REFERENCES public_packages(id) ON DELETE SET NULL;

CREATE INDEX idx_public_companion_assets_orca_updates
  ON public_companion_assets(user_id, auto_update_enabled, orca_profile_id);
CREATE INDEX idx_public_companion_assets_printer_config
  ON public_companion_assets(printer_config_id);
