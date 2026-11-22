type RepositoryDiffVersionRow = {
  files_json: string;
  version_number: number;
};

export function parseRepositoryDiffParams(url: URL) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from === null || to === null) {
    return null;
  }

  const fromVersion = Number(from);
  const toVersion = Number(to);

  return Number.isInteger(fromVersion) && Number.isInteger(toVersion)
    ? { fromVersion, toVersion }
    : null;
}

export function findRepositoryDiffVersions(
  versions: RepositoryDiffVersionRow[],
  fromVersion: number,
  toVersion: number,
) {
  const before = versions.find((version) => version.version_number === fromVersion);
  const after = versions.find((version) => version.version_number === toVersion);

  return before && after ? { after, before } : null;
}
