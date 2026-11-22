-- Migration number: 0013 	 2026-07-22T00:00:00.000Z

ALTER TABLE printers ADD COLUMN host_info_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE printers ADD COLUMN host_info_updated_at TEXT;
