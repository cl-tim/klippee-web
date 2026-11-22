import { createContext, useContext } from "react";
import type { ConfigFile, ConfigPackage } from "../../types";
import type { SafetyFinding } from "../../safety";
import type { PendingConfigImport } from "../types";
import type { StarterConfig } from "../../starterConfigs";

export type WorkspaceContextValue = {
  workspaceFilePath: string;
  currentWorkspaceContent: string;
  workspaceChanged: boolean;
  draftSaveStatus: string;
  /** ISO timestamp of the last idle draft autosave, or null before the first. */
  draftSavedAt: string | null;
  updateWorkspaceContent: (value: string) => void;
  selectWorkspaceFile: (file: ConfigFile) => void;
  importWorkspaceFiles: (files: FileList | File[] | null) => void;
  createWorkspaceFile: (path: string) => void;
  deleteWorkspaceFolder: (path: string) => void;
  deleteWorkspaceFile: (path: string) => void;
  renameWorkspaceFile: (oldPath: string, nextPath: string) => void;
  renameWorkspaceFolder: (oldPath: string, nextPath: string) => void;
  useStarterConfig: (starter: StarterConfig) => void;
  pendingConfigImport: PendingConfigImport | null;
  confirmConfigImportReplacement: () => void;
  cancelConfigImportReplacement: () => void;
  pendingWorkspaceFiles: ConfigFile[];
  /** Variables declared across the pending workspace files (workspace-derived, keystroke-churny). */
  packageVariables: ConfigPackage["variables"];
  missingIncludePaths: string[];
  safetyBlocked: boolean;
  safetyFindings: SafetyFinding[];
  /** Increments each time a lint finding requests a jump; consumed by the editor. */
  editorJumpTarget: { token: number; line: number } | null;
  jumpToLine: (path: string, line: number) => void;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspaceContext(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspaceContext must be used inside <WorkspaceProvider>");
  }
  return context;
}
