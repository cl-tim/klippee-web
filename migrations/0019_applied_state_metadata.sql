-- Migration number: 0019 	 2026-08-03T00:00:00.000Z

-- The applied pointer is owned by the physical printer. Record when the
-- printer last confirmed that a configuration was installed so the UI can
-- distinguish a live observation from an undated legacy pointer.
ALTER TABLE printers ADD COLUMN applied_at TEXT;

-- A public workspace listing must identify the printer whose confirmed
-- configuration it follows. repository_id alone is ambiguous because legacy
-- data does not enforce a one-printer-per-repository constraint.
ALTER TABLE public_packages
ADD COLUMN printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL;

UPDATE public_packages
SET printer_id = (
  SELECT printers.id
  FROM printers
  WHERE printers.user_id = public_packages.user_id
    AND printers.repository_id = public_packages.repository_id
    AND public_packages.source_package_id = 'printer-' || printers.id || '-workspace'
  LIMIT 1
)
WHERE printer_id IS NULL AND repository_id IS NOT NULL;

-- Preserve older linked listings when their repository has exactly one
-- unambiguous printer, even if they predate the workspace package id format.
UPDATE public_packages
SET printer_id = (
  SELECT MIN(printers.id)
  FROM printers
  WHERE printers.user_id = public_packages.user_id
    AND printers.repository_id = public_packages.repository_id
)
WHERE printer_id IS NULL
  AND repository_id IS NOT NULL
  AND 1 = (
    SELECT COUNT(*)
    FROM printers
    WHERE printers.user_id = public_packages.user_id
      AND printers.repository_id = public_packages.repository_id
  );

CREATE INDEX IF NOT EXISTS idx_public_packages_printer_id
ON public_packages(printer_id);
