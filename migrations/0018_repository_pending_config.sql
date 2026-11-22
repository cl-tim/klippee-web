-- Per-repository staged "pending" desired configuration.
--
-- Web edits auto-save here (via PUT /api/repos/:id/pending) instead of creating
-- a repository version. A physical printer's pull serves this pending config,
-- and the printer's apply (POST /api/sync/repos/:id/applied) materializes it
-- into a new repository version. pending_files_json uses the same manifest
-- format as repository_versions.files_json.
ALTER TABLE repositories ADD COLUMN pending_files_json TEXT;
ALTER TABLE repositories ADD COLUMN pending_updated_at TEXT;
