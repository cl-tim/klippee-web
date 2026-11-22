import type { ConfigFile } from "../types";

export type WorkspaceFileChoice = "local" | "cloud";
export type WorkspaceConflictFile = {
  path: string;
  baseline: ConfigFile | null | undefined;
  local: ConfigFile | null;
  cloud: ConfigFile | null;
  suggested: WorkspaceFileChoice | null;
};

function same(first: ConfigFile | null, second: ConfigFile | null) {
  return first?.content === second?.content;
}

/** Preserve independent edits; require a choice for edits to the same file. */
export function reviewWorkspaceFiles(baseline: ConfigFile[] | null, local: ConfigFile[], cloud: ConfigFile[]): WorkspaceConflictFile[] {
  const baseByPath = new Map(baseline?.map(file => [file.path, file]));
  const localByPath = new Map(local.map(file => [file.path, file]));
  const cloudByPath = new Map(cloud.map(file => [file.path, file]));
  return [...new Set([...baseByPath.keys(), ...localByPath.keys(), ...cloudByPath.keys()])].sort().map(path => {
    const base = baseByPath.get(path) ?? null;
    const localFile = localByPath.get(path) ?? null, cloudFile = cloudByPath.get(path) ?? null;
    const suggested = same(localFile, cloudFile) ? "local" : baseline === null ? null
      : same(localFile, base) ? "cloud" : same(cloudFile, base) ? "local" : null;
    return { path, baseline: baseline === null ? undefined : base, local: localFile, cloud: cloudFile, suggested };
  });
}

export function resolveWorkspaceFiles(files: WorkspaceConflictFile[], choices: Record<string, WorkspaceFileChoice>): ConfigFile[] | null {
  const result: ConfigFile[] = [];
  for (const file of files) {
    const choice = choices[file.path] ?? file.suggested;
    if (!choice) return null;
    const selected = choice === "local" ? file.local : file.cloud;
    if (selected) result.push(selected);
  }
  return result;
}
