import type { ConfigFile } from "../src/types";

type RepositoryRestoreVersionRow = {
  files_json: string;
  version_number: number;
};

export function findRepositoryRestoreVersions(
  versions: RepositoryRestoreVersionRow[],
  sourceVersionNumber: number,
) {
  const sourceVersion = versions.find((version) => version.version_number === sourceVersionNumber);
  const latestVersion = versions.reduce<RepositoryRestoreVersionRow | null>((latest, version) => {
    return !latest || version.version_number > latest.version_number ? version : latest;
  }, null);

  return sourceVersion && latestVersion ? { latestVersion, sourceVersion } : null;
}

export function restoreRepositoryFileIntoLatest(
  sourceFiles: ConfigFile[],
  latestFiles: ConfigFile[],
  path: string,
): ConfigFile[] | null {
  const restoredFile = sourceFiles.find((file) => file.path === path);
  if (!restoredFile) {
    return null;
  }

  return latestFiles.some((file) => file.path === path)
    ? latestFiles.map((file) => (file.path === path ? restoredFile : file))
    : [...latestFiles, restoredFile].sort((a, b) => a.path.localeCompare(b.path));
}
