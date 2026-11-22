import { createContext, useContext } from "react";
import type { RepositorySyncStatus, SyncTokenRecord } from "../types";
import type { HistoryVersion, PrinterState } from "../../types";
import type { WorkspaceConflictReview } from "../hooks/useWorkspaceConflict";
import type { WorkspaceFileChoice } from "../workspaceConflict";
import type { HistoryFileRestoreReview } from "../hooks/useHistoryFileRestore";

export type RepositoryContextValue = {
  history: HistoryVersion[];
  latestVersion: HistoryVersion | null;
  appliedVersion: HistoryVersion | null;
  historyChangedPaths: string[];
  printer: PrinterState;
  repoStatus: string;
  pendingConfiguration: RepositorySyncStatus["pendingConfiguration"];
  syncStatus: string;
  syncCheckedAt: string | null;
  syncConflict: boolean;
  historyFileRestoreReview: HistoryFileRestoreReview | null;
  historyFileRestoreBusy: boolean;
  historyFileRestoreStatus: string;
  reviewHistoryFileRestore: (versionNumber: number, path: string) => Promise<void>;
  confirmHistoryFileRestore: () => Promise<void>;
  cancelHistoryFileRestore: (force?: boolean) => void;
  workspaceConflictReview: WorkspaceConflictReview | null;
  workspaceConflictBusy: boolean;
  workspaceConflictStatus: string;
  reviewWorkspaceConflict: () => Promise<void>;
  resolveWorkspaceConflict: (choices: Record<string, WorkspaceFileChoice>) => Promise<void>;
  closeWorkspaceConflictReview: () => void;
  syncToken: string;
  syncTokens: SyncTokenRecord[];
  syncPullUrl: string;
  clientInstallCommand: string;
  buildDesktopInstallCommand: (platform?: "windows" | "unix") => string;
  buildPrinterInstallCommand: (configDirectory?: string, captureCurrent?: boolean) => string;
  createCloudRepository: () => Promise<void>;
  createDesktopSyncToken: () => Promise<void>;
  createPrinterSyncToken: () => Promise<void>;
  deleteVersion: (version: HistoryVersion) => Promise<boolean>;
  linkCurrentPrinter: () => Promise<void>;
  refreshSyncStatus: () => Promise<void>;
  revokeSyncToken: (tokenId: string) => Promise<void>;
  loadActiveRepositoryHistory: () => Promise<void>;
  forkFromVersion: (version: HistoryVersion) => Promise<void>;
};

export const RepositoryContext = createContext<RepositoryContextValue | null>(null);

export function useRepositoryContext(): RepositoryContextValue {
  const context = useContext(RepositoryContext);
  if (!context) {
    throw new Error("useRepositoryContext must be used inside <RepositoryProvider>");
  }
  return context;
}
