-- Migration number: 0010 	 2026-05-22T00:00:00.000Z

-- Denormalized, indexed facets for public package discovery so the registry can
-- filter by printer, tag, and free text without scanning and JSON-parsing every
-- row. Populated by the Worker on publish (see worker/routes/packages.ts) and
-- backfilled here from existing package_json.

ALTER TABLE public_packages ADD COLUMN printer_facet TEXT NOT NULL DEFAULT '';
ALTER TABLE public_packages ADD COLUMN tags_facet TEXT NOT NULL DEFAULT '';
ALTER TABLE public_packages ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

UPDATE public_packages SET
  printer_facet = lower(COALESCE(json_extract(package_json, '$.printer'), '')),
  tags_facet = '|' || COALESCE((SELECT group_concat(lower(value), '|') FROM json_each(package_json, '$.tags')), '') || '|',
  search_text = lower(
    COALESCE(json_extract(package_json, '$.title'), '') || ' ' ||
    COALESCE(json_extract(package_json, '$.description'), '') || ' ' ||
    COALESCE(json_extract(package_json, '$.printer'), '') || ' ' ||
    COALESCE((SELECT group_concat(value, ' ') FROM json_each(package_json, '$.hardware')), '') || ' ' ||
    COALESCE((SELECT group_concat(value, ' ') FROM json_each(package_json, '$.tags')), '')
  );

CREATE INDEX IF NOT EXISTS idx_public_packages_printer_facet ON public_packages(printer_facet);
