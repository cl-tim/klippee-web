import { useMemo } from "react";
import {
  extractIncludes,
  variablesFromFiles,
} from "../../packageBuilder";
import { changedPaths } from "../../rendering";
import { hasBlockingSafetyFindings, scanConfigFiles } from "../../safety";
import type { ConfigFile, HistoryVersion } from "../../types";

type WorkspaceAnalysisOptions = {
  history: HistoryVersion[];
  latestVersion: HistoryVersion | null;
  workspaceContent: string;
  workspaceDrafts: Record<string, string>;
  workspaceDraftFiles: ConfigFile[] | null;
  workspaceFilePath: string;
};

export function useWorkspaceAnalysis({
  history,
  latestVersion,
  workspaceContent,
  workspaceDrafts,
  workspaceDraftFiles,
  workspaceFilePath,
}: WorkspaceAnalysisOptions) {
  // Base file set comes from the draft set if there is one (structural edits
  // like import/create/rename/delete), otherwise from the latestVersion.
  const baseFiles = useMemo(
    () => workspaceDraftFiles ?? latestVersion?.files ?? [],
    [workspaceDraftFiles, latestVersion],
  );
  const currentWorkspaceFile = baseFiles.find((file) => file.path === workspaceFilePath) ?? baseFiles[0] ?? null;
  const currentWorkspaceContent =
    (currentWorkspaceFile ? workspaceDrafts[currentWorkspaceFile.path] : undefined) ?? currentWorkspaceFile?.content ?? workspaceContent;
  const workspaceChanged = workspaceDraftFiles !== null
    || baseFiles.some((file) => workspaceDrafts[file.path] !== undefined && workspaceDrafts[file.path] !== file.content);
  const pendingWorkspaceFiles = useMemo(
    () =>
      baseFiles.map((file) =>
        workspaceDrafts[file.path] !== undefined ? { ...file, content: workspaceDrafts[file.path] } : file,
      ),
    [baseFiles, workspaceDrafts],
  );
  const safetyFindings = useMemo(() => scanConfigFiles(pendingWorkspaceFiles), [pendingWorkspaceFiles]);
  const safetyBlocked = hasBlockingSafetyFindings(safetyFindings);
  const missingIncludePaths = useMemo(() => extractIncludes(pendingWorkspaceFiles), [pendingWorkspaceFiles]);
  const packageVariables = useMemo(
    () => variablesFromFiles(pendingWorkspaceFiles, []),
    [pendingWorkspaceFiles],
  );
  const historyChangedPaths = useMemo(
    () =>
      !latestVersion
        ? []
        : history.length > 1
        ? changedPaths(history[history.length - 2].files, latestVersion.files)
        : latestVersion.files.map((file: ConfigFile) => file.path),
    [history, latestVersion],
  );

  return {
    currentWorkspaceContent,
    currentWorkspaceFile,
    historyChangedPaths,
    missingIncludePaths,
    packageVariables,
    pendingWorkspaceFiles,
    safetyBlocked,
    safetyFindings,
    workspaceChanged,
  };
}
