-- Migration number: 0011 	 2026-05-23T00:00:00.000Z

-- Additional indexes for the denormalized public-package discovery columns.
-- The Worker keeps these columns populated on publish, so public package list
-- filters avoid JSON parsing on the hot read path.

CREATE INDEX IF NOT EXISTS idx_public_packages_tags_facet ON public_packages(tags_facet);
CREATE INDEX IF NOT EXISTS idx_public_packages_search_text ON public_packages(search_text);
