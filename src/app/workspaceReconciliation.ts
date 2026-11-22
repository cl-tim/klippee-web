import type { CloudDesiredConfiguration, CloudRepositoryVersion } from "./types";
import type { ConfigFile, HistoryVersion } from "../types";

/**
 * Pure reconciliation between a repository's cloud state (immutable versions +
 * current desired configuration) and the browser's local workspace cache.
 * Extracted from useKlippeeApp.loadRepositoryHistory so the three-way branch
 * below is unit-testable without mounting the whole hook.
 */

export type ReconcileRepositoryWorkspaceInput = {
  /** Cloud immutable versions; sorted by version number internally. */
  cloudVersions: CloudRepositoryVersion[];
  /** Current desired configuration reported by the repository, if any. */
  desired: CloudDesiredConfiguration | null;
  /** Local structural draft file set (null when tracking the latest version). */
  localStructuralFiles: ConfigFile[] | null;
  /** Local per-file content drafts keyed by path. */
  localDrafts: Record<string, string>;
  /** Original file set beneath content-only local edits, before cloud reload. */
  localBaseFiles?: ConfigFile[];
  /**
   * Desired-config revision the local workspace was last based on.
   * `undefined` means a legacy cache with no recorded baseline.
   */
  localBaseRevision: string | null | undefined;
  /** Revision hash of the latest immutable cloud version's files, or null. */
  latestRevision: string | null;
  /** Revision hash of the local effective files, or null when no local draft. */
  localRevision: string | null;
  /** File path to keep open when it still exists in the next file set. */
  preferredPath: string;
};

export type ReconciledRepositoryWorkspace = {
  history: HistoryVersion[];
  draftFiles: ConfigFile[] | null;
  drafts: Record<string, string>;
  filePath: string;
  content: string;
  workspaceBaseRevision: string | null | undefined;
};

export function sortCloudVersions(versions: CloudRepositoryVersion[]): CloudRepositoryVersion[] {
  return [...versions].sort((a, b) => a.version_number - b.version_number);
}

export function historyFromCloudVersions(versions: CloudRepositoryVersion[]): HistoryVersion[] {
  const sorted = sortCloudVersions(versions);
  return sorted.map((version, index) => ({
    createdAt: version.created_at,
    files: version.files,
    id: version.version_number,
    message: version.message,
    previousId: index === 0 ? null : sorted[index - 1].version_number,
    source: version.source,
  }));
}

export function hasLocalWorkspaceDraft(
  localStructuralFiles: ConfigFile[] | null,
  localDrafts: Record<string, string>,
): boolean {
  return localStructuralFiles !== null || Object.keys(localDrafts).length > 0;
}

/** The files the local workspace effectively shows: base set + content drafts. */
export function effectiveLocalWorkspaceFiles(
  localStructuralFiles: ConfigFile[] | null,
  localDrafts: Record<string, string>,
  latestCloudFiles: ConfigFile[],
): ConfigFile[] {
  const base = localStructuralFiles ?? latestCloudFiles;
  return base.map((file) => {
    const content = localDrafts[file.path];
    return content === undefined ? file : { ...file, content };
  });
}

export function reconcileRepositoryWorkspace(
  input: ReconcileRepositoryWorkspaceInput,
): ReconciledRepositoryWorkspace {
  const {
    cloudVersions,
    desired,
    localStructuralFiles,
    localDrafts,
    localBaseRevision,
    latestRevision,
    localRevision,
    preferredPath,
  } = input;

  const history = historyFromCloudVersions(cloudVersions);
  const latestCloudVersion = history[history.length - 1] ?? null;
  const latestCloudFiles = latestCloudVersion?.files ?? [];
  const desiredDraft = desired?.pending ? desired : null;
  const hasLocalWorkspace = hasLocalWorkspaceDraft(localStructuralFiles, localDrafts);
  const localMatchesDesired = localRevision !== null
    && localRevision === desired?.revision;
  const unchangedLocalSnapshot = Boolean(
    desiredDraft
    && localRevision !== null
    && localRevision === localBaseRevision,
  );

  let draftFiles: ConfigFile[] | null;
  let drafts: Record<string, string>;
  let workspaceBaseRevision: string | null | undefined;

  if (!hasLocalWorkspace && !desiredDraft && latestCloudFiles.length === 0) {
    // A real structural draft makes a brand-new repository immediately
    // editable and stageable; a path/content placeholder alone is invisible
    // to workspace analysis and can never be uploaded.
    draftFiles = [{ content: "", path: "printer.cfg", public: false, role: "printer" }];
    drafts = {};
    workspaceBaseRevision = null;
  } else if (!hasLocalWorkspace || localMatchesDesired || unchangedLocalSnapshot) {
    // Immutable versions are recovery history, not necessarily the current
    // desired configuration. Reopen an authoritative pending draft, normalize
    // an equivalent local cache, or refresh a cache unchanged from its own
    // baseline. Matching an old immutable version alone does not prove that
    // a local draft is unchanged: it may be an intentional reversion.
    draftFiles = desiredDraft?.files ?? null;
    drafts = {};
    workspaceBaseRevision = desired?.revision ?? latestRevision;
  } else {
    // A locally divergent edit remains visible. Keep its original baseline so
    // staging detects a concurrent desired-config change instead of silently
    // overwriting it.
    // Pin content-only edits to their original file set, including files
    // removed by a newer capture. New history must not hide unsaved files.
    draftFiles = localStructuralFiles ?? input.localBaseFiles ?? null;
    drafts = localDrafts;
    workspaceBaseRevision = localBaseRevision === undefined
      ? latestRevision
      : localBaseRevision;
  }

  const files = draftFiles ?? latestCloudFiles;
  const firstFile = files.find((file) => file.path === preferredPath) ?? files[0];
  const filePath = firstFile?.path ?? "printer.cfg";
  const content = firstFile ? drafts[firstFile.path] ?? firstFile.content : "";

  return { content, draftFiles, drafts, filePath, history, workspaceBaseRevision };
}
