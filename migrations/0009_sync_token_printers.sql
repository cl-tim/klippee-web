-- Migration number: 0009 	 2026-05-15T00:00:00.000Z

ALTER TABLE sync_tokens ADD COLUMN printer_id TEXT REFERENCES printers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sync_tokens_printer_id
ON sync_tokens(printer_id);
