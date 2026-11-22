import type { VariableValues } from "../rendering";
import type { CompanionAsset, ConfigFile, HistoryVersion, PrinterState } from "../types";

export type Tab =
  | "Setup"
  | "Slicer"
  | "Printers"
  | "Registry"
  | "Diagnostics"
  | "Gridfinity"
  | "OpenGrid"
  | "Underware";

export type AuthProvider = "github" | "discord";

export type AuthUser = {
  avatarUrl: string | null;
  displayName: string;
  id: string;
  providers: AuthProvider[];
  mode?: "local";
};

export type CloudState = {
  history: HistoryVersion[];
  printer: PrinterState;
  printers?: PrinterRecord[];
  repositoryId?: string | null;
  selectedPrinterId?: string;
  selectedFilePath: string;
  selectedCompanionAssetId?: string;
  selectedPackageId: string;
  workspaceContent: string;
  workspaceFilePath: string;
};

export type PendingConfigImport = {
  conflicts: string[];
  files: ConfigFile[];
  /** Workspace identity captured before file reads or replacement review. */
  workspaceContext: {
    generation: number;
    ownerPrinterId: string;
    selectedPrinterId: string;
  };
};

export type PrinterHostInfo = {
  arch?: string;
  cliVersion?: string;
  hostname?: string;
  kernel?: string;
  klipperVersion?: string;
  klippyState?: string;
  moonrakerVersion?: string;
  os?: string;
};

export type PrinterRecord = {
  appliedAt?: string | null;
  appliedVersionId: number;
  createdAt: string;
  definition?: Record<string, unknown>;
  description: string;
  history?: HistoryVersion[];
  hostInfo?: PrinterHostInfo;
  hostInfoUpdatedAt?: string | null;
  id: string;
  latestVersionId: number;
  make: string;
  model: string;
  name: string;
  packageIds: string[];
  companionAssetIds?: string[];
  repositoryId?: string | null;
  source: "catalog" | "custom" | "manual" | "orcaslicer";
  updatedAt: string;
  variableValues?: VariableValues;
  /** Desired-config revision this browser workspace was last based on. */
  workspaceBaseRevision?: string | null;
  /** Local snapshot of the revision used for three-way conflict review. */
  workspaceBaseFiles?: ConfigFile[];
  workspaceDraftFiles?: ConfigFile[] | null;
  workspaceDrafts?: Record<string, string>;
  workspaceFilePath?: string;
};

export type PrinterDraft = {
  description: string;
  make: string;
  model: string;
  name: string;
  source: PrinterRecord["source"];
};

export type PackageDraft = {
  description: string;
  hardware: string;
  printer: string;
  tags: string;
  title: string;
};

export type PublicPackageApprovalStatus = {
  approvedVersionId: string | null;
  autoUpdateEnabled: boolean;
  autoUpdateError: string | null;
  currentAppliedVersionId: string | null;
  hasUnpublishedAppliedVersion: boolean;
  linked: boolean;
};

export type PrinterPublicationCandidate = {
  appliedAt: string | null;
  files: ConfigFile[];
  repositoryId: string;
  versionId: string;
  versionNumber: number;
};

export type CompanionAssetDraft = {
  content: string;
  description: string;
  kind: CompanionAsset["kind"];
  printerId?: string | null;
  tags: string;
  title: string;
  structured?: Record<string, string>;
};

/** A preset parsed from an imported file, ready to become a companion asset. */
export type CompanionAssetImport = {
  kind: CompanionAsset["kind"];
  printerId?: string | null;
  title: string;
  content: string;
  tags?: string[];
};

export type CloudRepositoryVersion = {
  created_at: string;
  files: ConfigFile[];
  id: string;
  message: string;
  previous_version_id: string | null;
  source: HistoryVersion["source"];
  version_number: number;
};

export type CloudDesiredConfiguration = {
  createdAt: string;
  files: ConfigFile[];
  pending: boolean;
  revision: string;
  source: string;
  versionId: string | null;
  versionNumber: number;
};

export type SyncTokenRecord = {
  created_at: string;
  id: string;
  last_used_at: string | null;
  name: string;
  printer_id: string | null;
  scopes: string[];
  token_prefix: string;
};

export type RepositorySyncStatus = {
  appliedVersion?: { version_number: number } | null;
  latestVersion?: { message?: string; version_number: number } | null;
  pendingConfiguration?: {
    fileCount: number;
    revision: string;
    updatedAt: string;
  } | null;
  printer?: PrinterRecord | null;
  targetVersionNumber?: number;
  targetRevision?: string | null;
  updateAvailable?: boolean;
};
