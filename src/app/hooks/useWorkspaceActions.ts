import { useRef, type Dispatch, type SetStateAction } from "react";
import { maxImportedConfigFileBytes, maxImportFiles } from "../constants";
import { formatBytes } from "../format";
import {
  normalizeWorkspacePath,
  sortConfigFiles,
} from "../helpers";
import type { PackageDraft, PendingConfigImport, PrinterRecord } from "../types";
import {
  inferRole,
  isImportableWorkspaceConfigPath,
  normalizeImportPath,
} from "../../packageBuilder";
import type { ConfigFile } from "../../types";
import type { StarterConfig } from "../../starterConfigs";
import { useAccountStorage } from "../contexts/useAccountStorage";
import {
  normalizeWorkspaceFolderPath,
  planWorkspaceMove,
} from "../../features/workflows/workspaceTree";

type WorkspaceActionsOptions = {
  currentWorkspaceFile: ConfigFile | null;
  pendingConfigImport: PendingConfigImport | null;
  pendingWorkspaceFiles: ConfigFile[];
  selectedPrinter: PrinterRecord | null;
  setBuildStatus: (status: string) => void;
  setPackageDraft: Dispatch<SetStateAction<PackageDraft>>;
  setPendingConfigImport: Dispatch<SetStateAction<PendingConfigImport | null>>;
  setWorkspaceContent: (content: string) => void;
  setWorkspaceDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setWorkspaceDraftFiles: Dispatch<SetStateAction<ConfigFile[] | null>>;
  setWorkspaceFilePath: (path: string) => void;
  workspaceFilePath: string;
  workspaceDrafts: Record<string, string>;
  getWorkspaceContext: () => PendingConfigImport["workspaceContext"];
};

export function useWorkspaceActions({
  currentWorkspaceFile,
  pendingConfigImport,
  pendingWorkspaceFiles,
  selectedPrinter,
  setBuildStatus,
  setPackageDraft,
  setPendingConfigImport,
  setWorkspaceContent,
  setWorkspaceDrafts,
  setWorkspaceDraftFiles,
  setWorkspaceFilePath,
  workspaceDrafts,
  workspaceFilePath,
  getWorkspaceContext,
}: WorkspaceActionsOptions) {
  const { saveStored } = useAccountStorage();
  const importSequenceRef = useRef(0);
  // Update the working file set without creating a HistoryVersion. The draft
  // is persisted to localStorage so it survives reload; the physical printer
  // creates immutable history only when it applies or captures configuration.
  function mutateDraftFiles(files: ConfigFile[]) {
    setWorkspaceDraftFiles(files);
    saveStored("workspaceDraftFiles", files);
    const firstFile = files.find((file) => file.path === workspaceFilePath) ?? files[0];
    if (firstFile) {
      setWorkspaceFilePath(firstFile.path);
      const draftedContent = workspaceDrafts[firstFile.path] ?? firstFile.content;
      setWorkspaceContent(draftedContent);
      saveStored("workspaceContent", draftedContent);
    }
  }

  function replaceStructuralDraft(files: ConfigFile[], preferredPath: string) {
    setWorkspaceDraftFiles(files);
    setWorkspaceDrafts({});
    saveStored("workspaceDraftFiles", files);
    saveStored("workspaceDrafts", {});
    const selectedFile = files.find((file) => file.path === preferredPath) ?? files[0];
    if (selectedFile) {
      setWorkspaceFilePath(selectedFile.path);
      setWorkspaceContent(selectedFile.content);
      saveStored("workspaceContent", selectedFile.content);
    }
  }
  function selectWorkspaceFile(file: ConfigFile) {
    setWorkspaceFilePath(file.path);
    setWorkspaceContent(workspaceDrafts[file.path] ?? file.content);
    saveStored("workspaceContent", workspaceDrafts[file.path] ?? file.content);
  }

  function updateWorkspaceContent(value: string) {
    if (!currentWorkspaceFile) {
      setWorkspaceContent(value);
      saveStored("workspaceContent", value);
      return;
    }

    setWorkspaceContent(value);
    setWorkspaceDrafts((current) => {
      const next = { ...current };
      if (value === currentWorkspaceFile.content) {
        delete next[currentWorkspaceFile.path];
      } else {
        next[currentWorkspaceFile.path] = value;
      }
      saveStored("workspaceDrafts", next);
      return next;
    });
    saveStored("workspaceContent", value);
  }

  function replaceWorkspaceDraftFiles(files: ConfigFile[]) {
    setWorkspaceDraftFiles(files);
    setWorkspaceDrafts({});
    saveStored("workspaceDraftFiles", files);
    saveStored("workspaceDrafts", {});
    const firstFile = files.find((file) => file.path === workspaceFilePath) ?? files[0];
    if (firstFile) {
      setWorkspaceFilePath(firstFile.path);
      setWorkspaceContent(firstFile.content);
      saveStored("workspaceContent", firstFile.content);
    }
  }

  function applyImportedWorkspaceFiles(importedFiles: ConfigFile[], rejectedCount = 0) {
    const importedByPath = new Map(importedFiles.map((file) => [file.path, file]));
    const keptFiles = pendingWorkspaceFiles.filter((file) => !importedByPath.has(file.path));
    const nextFiles = sortConfigFiles([...keptFiles, ...importedFiles]);
    const rejectedSummary =
      rejectedCount > 0
        ? `; skipped ${rejectedCount} non-config or sensitive file${rejectedCount === 1 ? "" : "s"}`
        : "";

    mutateDraftFiles(nextFiles);
    setBuildStatus(
      `Imported ${importedFiles.length} config file${importedFiles.length === 1 ? "" : "s"}${rejectedSummary} (draft; apply it explicitly on the printer when ready)`,
    );
  }

  function createWorkspaceFile(pathValue: string) {
    const path = normalizeWorkspacePath(pathValue);
    if (!path) {
      setBuildStatus("Enter a .cfg path");
      return;
    }
    if (pendingWorkspaceFiles.some((file) => file.path === path)) {
      setBuildStatus(`${path} already exists`);
      return;
    }

    const nextFiles = sortConfigFiles([
      ...pendingWorkspaceFiles,
      {
        content: "",
        path,
        public: false,
        role: inferRole(path),
      },
    ]);
    mutateDraftFiles(nextFiles);
    setWorkspaceFilePath(path);
    setWorkspaceContent("");
    setBuildStatus(`Created ${path} (draft)`);
  }

  function renameWorkspaceFile(oldPath: string, nextPathValue: string) {
    const nextPath = normalizeWorkspacePath(nextPathValue);
    if (!nextPath) {
      setBuildStatus("Enter a .cfg path");
      return;
    }
    const plan = planWorkspaceMove(pendingWorkspaceFiles, oldPath, nextPath, "file");
    if (plan.error || !plan.files) {
      setBuildStatus(plan.error ?? "Unable to rename file");
      return;
    }

    const nextFiles = sortConfigFiles(
      plan.files.map((file) => ({ ...file, role: inferRole(file.path) })),
    );
    const selectedPath = plan.movedPaths.get(workspaceFilePath) ?? workspaceFilePath;
    replaceStructuralDraft(nextFiles, selectedPath);
    const includeSummary = plan.includeReferences.length > 0
      ? ` and updated ${plan.includeReferences.length} include reference${plan.includeReferences.length === 1 ? "" : "s"}`
      : "";
    setBuildStatus(`Renamed ${oldPath}${includeSummary} (draft)`);
  }

  function renameWorkspaceFolder(oldPath: string, nextPathValue: string) {
    const nextPath = normalizeWorkspaceFolderPath(nextPathValue);
    if (!nextPath) {
      setBuildStatus("Enter a valid folder path");
      return;
    }
    const plan = planWorkspaceMove(pendingWorkspaceFiles, oldPath, nextPath, "folder");
    if (plan.error || !plan.files) {
      setBuildStatus(plan.error ?? "Unable to move folder");
      return;
    }

    const nextFiles = sortConfigFiles(plan.files.map((file) => ({ ...file, role: inferRole(file.path) })));
    const selectedPath = plan.movedPaths.get(workspaceFilePath) ?? workspaceFilePath;
    replaceStructuralDraft(nextFiles, selectedPath);
    const includeSummary = plan.includeReferences.length > 0
      ? ` and updated ${plan.includeReferences.length} include reference${plan.includeReferences.length === 1 ? "" : "s"}`
      : "";
    setBuildStatus(
      `Moved ${plan.movedPaths.size} config file${plan.movedPaths.size === 1 ? "" : "s"} to ${nextPath}${includeSummary} (draft)`,
    );
  }

  function deleteWorkspaceFile(path: string) {
    if (pendingWorkspaceFiles.length <= 1) {
      setBuildStatus("Keep at least one config file");
      return;
    }
    const nextFiles = sortConfigFiles(pendingWorkspaceFiles.filter((file) => file.path !== path));
    mutateDraftFiles(nextFiles);
    setBuildStatus(`Deleted ${path} (draft)`);
  }

  function deleteWorkspaceFolder(path: string) {
    const filesToDelete = pendingWorkspaceFiles.filter((file) => file.path.startsWith(`${path}/`));
    if (filesToDelete.length === 0) {
      setBuildStatus(`${path} is empty`);
      return;
    }
    const nextFiles = sortConfigFiles(
      pendingWorkspaceFiles.filter((file) => !file.path.startsWith(`${path}/`)),
    );
    if (nextFiles.length === 0) {
      setBuildStatus("Keep at least one config file");
      return;
    }
    replaceStructuralDraft(nextFiles, workspaceFilePath);
    setBuildStatus(
      `Deleted ${filesToDelete.length} config file${filesToDelete.length === 1 ? "" : "s"} from ${path} (draft)`,
    );
  }

  function workspaceContextIsCurrent(context: PendingConfigImport["workspaceContext"]) {
    const current = getWorkspaceContext();
    return current.generation === context.generation
      && current.ownerPrinterId === context.ownerPrinterId
      && current.selectedPrinterId === context.selectedPrinterId;
  }

  function rejectStaleImport(clearPendingConfirmation = false) {
    if (clearPendingConfirmation) {
      setPendingConfigImport(null);
    }
    setBuildStatus("Import cancelled because the printer or workspace changed; choose the files again");
  }

  async function importWorkspaceFiles(fileList: FileList | File[] | null) {
    const importSequence = ++importSequenceRef.current;
    setPendingConfigImport(null);
    const workspaceContext = getWorkspaceContext();
    const candidates = Array.from(fileList ?? []);
    const normalizedFiles = candidates
      .map((file) => ({ file, path: normalizeWorkspacePath(normalizeImportPath(file)) }))
      .filter((candidate): candidate is { file: File; path: string } => Boolean(candidate.path));
    const selectedFiles = normalizedFiles.filter(({ path }) => isImportableWorkspaceConfigPath(path));
    const rejectedCount = normalizedFiles.length - selectedFiles.length;

    if (selectedFiles.length > maxImportFiles) {
      setBuildStatus(`Import up to ${maxImportFiles} config files at once`);
      return;
    }

    if (selectedFiles.length === 0) {
      setBuildStatus(
        rejectedCount > 0
          ? `Rejected ${rejectedCount} non-config or sensitive file${rejectedCount === 1 ? "" : "s"}`
          : "Choose one or more .cfg files",
      );
      return;
    }

    const oversized = selectedFiles.find(({ file }) => file.size > maxImportedConfigFileBytes);
    if (oversized) {
      setBuildStatus(`${oversized.path} is larger than ${formatBytes(maxImportedConfigFileBytes)}`);
      return;
    }

    const importPaths = new Set<string>();
    const duplicate = selectedFiles.find(({ path }) => {
      if (importPaths.has(path)) {
        return true;
      }
      importPaths.add(path);
      return false;
    });
    if (duplicate) {
      setBuildStatus(`${duplicate.path} appears more than once in this import`);
      return;
    }

    const importedFiles = await Promise.all(
      selectedFiles.map(async ({ file, path }) => ({
        content: await file.text(),
        path,
        public: false,
        role: inferRole(path),
      })),
    );
    if (importSequenceRef.current !== importSequence) {
      return;
    }
    if (!workspaceContextIsCurrent(workspaceContext)) {
      rejectStaleImport();
      return;
    }
    const sortedFiles = sortConfigFiles(importedFiles);
    const existingPaths = new Set(pendingWorkspaceFiles.map((file) => file.path));
    const conflicts = sortedFiles.filter((file) => existingPaths.has(file.path)).map((file) => file.path);

    if (conflicts.length > 0) {
      setPendingConfigImport({ conflicts, files: sortedFiles, workspaceContext });
      const rejectedSummary =
        rejectedCount > 0
          ? `; skipped ${rejectedCount} non-config or sensitive file${rejectedCount === 1 ? "" : "s"}`
          : "";
      setBuildStatus(
        `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} need replacement confirmation${rejectedSummary}`,
      );
      return;
    }

    applyImportedWorkspaceFiles(sortedFiles, rejectedCount);
  }

  function confirmConfigImportReplacement() {
    if (!pendingConfigImport) {
      return;
    }
    if (!workspaceContextIsCurrent(pendingConfigImport.workspaceContext)) {
      rejectStaleImport(true);
      return;
    }
    applyImportedWorkspaceFiles(pendingConfigImport.files);
    setPendingConfigImport(null);
  }

  function cancelConfigImportReplacement() {
    setBuildStatus("Import cancelled");
    setPendingConfigImport(null);
  }

  function useStarterConfig(starter: StarterConfig) {
    const files = starter.files.map((file) => ({ ...file }));
    mutateDraftFiles(files);
    setPackageDraft((current) => ({
      ...current,
      description: starter.description,
      hardware: starter.tags.filter((tag) => tag !== "starter").join(", "),
      tags: Array.from(new Set(["private", ...starter.tags])).join(", "),
      title: selectedPrinter ? `${selectedPrinter.name} ${starter.title}` : starter.title,
    }));
    setBuildStatus(`Started workspace from ${starter.title}`);
  }

  return {
    cancelConfigImportReplacement,
    confirmConfigImportReplacement,
    createWorkspaceFile,
    deleteWorkspaceFolder,
    deleteWorkspaceFile,
    importWorkspaceFiles,
    renameWorkspaceFile,
    renameWorkspaceFolder,
    replaceWorkspaceDraftFiles,
    selectWorkspaceFile,
    updateWorkspaceContent,
    useStarterConfig,
  };
}
