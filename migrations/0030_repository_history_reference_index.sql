-- Keep deletion guards and lineage FK checks from scanning every user's history.
CREATE INDEX IF NOT EXISTS idx_repository_versions_previous_version_id
ON repository_versions(previous_version_id);
