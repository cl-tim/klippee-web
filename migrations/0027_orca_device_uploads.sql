ALTER TABLE orca_devices ADD COLUMN uploads_enabled INTEGER NOT NULL DEFAULT 0 CHECK (uploads_enabled IN (0, 1));
-- Each reviewed upload retains its own retry-safe, short-lived operation.
ALTER TABLE orca_capture_grants ADD COLUMN device_id TEXT REFERENCES orca_devices(id) ON DELETE CASCADE;
CREATE INDEX idx_orca_capture_grants_device ON orca_capture_grants(device_id);
