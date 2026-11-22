-- Public workspace listings follow the repository's desired configuration.

ALTER TABLE public_packages
ADD COLUMN repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;

-- Current workspace publications use this deterministic source package id.
-- Link those existing rows immediately; older custom package publications
-- remain frozen until their owner explicitly republishes them from a workspace.
UPDATE public_packages
SET repository_id = (
  SELECT printers.repository_id
  FROM printers
  WHERE printers.user_id = public_packages.user_id
    AND printers.repository_id IS NOT NULL
    AND public_packages.source_package_id = 'printer-' || printers.id || '-workspace'
  LIMIT 1
)
WHERE repository_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_public_packages_repository_id
ON public_packages(repository_id);
