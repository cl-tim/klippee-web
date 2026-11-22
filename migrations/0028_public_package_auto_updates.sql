ALTER TABLE public_packages ADD COLUMN auto_update_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (auto_update_enabled IN (0, 1));
ALTER TABLE public_packages ADD COLUMN auto_update_error TEXT;
