-- Migration number: 0020 	 2026-08-04T00:00:00.000Z

-- Public content has a separate owner-controlled approval pointer. Printer
-- credentials remain authoritative for physical applied state, but cannot
-- silently advance files that anonymous users can download.
ALTER TABLE public_packages
ADD COLUMN approved_version_id TEXT
REFERENCES repository_versions(id) ON DELETE SET NULL;

-- Existing linked publications deliberately remain NULL. Their stored
-- package_json is the last owner-created public snapshot; the owner must
-- explicitly republish before a repository version gains approval provenance.
CREATE INDEX IF NOT EXISTS idx_public_packages_approved_version_id
ON public_packages(approved_version_id);
