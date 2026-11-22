import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { matchPath, useLocation, useNavigate } from "react-router";
import { cloudFetch } from "./cloudFetch";
import {
  parseAppStateResponse,
  parseCompanionAssetResponse,
  parseCompanionAssetsResponse,
  parseForkResponse,
  parsePrivatePackagesResponse,
  parseRepoListResponse,
  verifyRepositoryVersionsResponse,
} from "./responseGuards";
import {
  effectiveLocalWorkspaceFiles,
  hasLocalWorkspaceDraft,
  reconcileRepositoryWorkspace,
  sortCloudVersions,
} from "./workspaceReconciliation";
import type { AuthSession } from "./hooks/useAuthSession";
import { cloudAppStatesEqual, useCloudAppState } from "./hooks/useCloudAppState";
import { useCompanionAssets } from "./hooks/useCompanionAssets";
import { useCompanionAssetDeletion } from "./hooks/useCompanionAssetDeletion";
import { usePackageActions } from "./hooks/usePackageActions";
import { usePersistedState } from "./hooks/usePersistedState";
import { usePrinters, type PrinterWorkspaceSnapshot } from "./hooks/usePrinters";
import { useStableHandlers } from "./hooks/useStableHandlers";
import { usePublicPackageCatalog } from "./hooks/usePublicPackageCatalog";
import { useRepositorySync } from "./hooks/useRepositorySync";
import { useWorkspaceConflict } from "./hooks/useWorkspaceConflict";
import { useHistoryFileRestore } from "./hooks/useHistoryFileRestore";
import { useSelectedPackage } from "./hooks/useSelectedPackage";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { useWorkspaceAnalysis } from "./hooks/useWorkspaceAnalysis";
import { pathTabs, protectedTabs, tabPaths } from "./constants";
import type {
  CloudState,
  CompanionAssetImport,
  PackageDraft,
  PendingConfigImport,
  PrinterRecord,
  Tab,
} from "./types";
import {
  loadInitialCompanionAssets,
  loadInitialHistory,
  loadInitialPrivatePackages,
  loadInitialWorkspaceContent,
} from "./helpers";
import { initialPrinter } from "../data";
import { repositoryFilesRevision } from "../repositoryRevision";
import type { StarterConfig } from "../starterConfigs";
import {
  createPackageZip,
  declaredPackageVariableValues,
  downloadBlob,
  PackageRenderLimitError,
  unresolvedVariables,
  validateVariables,
  type VariableValues,
} from "../rendering";
import { useAccountStorage } from "./contexts/useAccountStorage";
import type { CompanionAsset, ConfigFile, ConfigPackage, HistoryVersion, PrinterState } from "../types";

function tabFromPath(pathname: string): Tab {
  if (matchPath("/packages/:packageId", pathname)) {
    return "Registry";
  }
  return pathTabs.get(pathname) ?? "Setup";
}

export function useKlippeeApp(authSession: AuthSession) {
  const { hasStored, loadStored, saveStored, setAndPersist, status: localStorageStatus } = useAccountStorage();
  const location = useLocation();
  const navigate = useNavigate();
  const startingHistory = useMemo(() => loadInitialHistory(loadStored), [loadStored]);
  const startingPrinters = useMemo(() => loadStored("printers", [] as PrinterRecord[]), [loadStored]);
  const startingCompanionAssets = useMemo(() => loadInitialCompanionAssets(loadStored), [loadStored]);
  const startingPrivatePackages = useMemo(() => loadInitialPrivatePackages(loadStored), [loadStored]);
  const startingSelectedPrinterId = useMemo(() => loadStored("selectedPrinterId", ""), [loadStored]);
  // No hardcoded seed values: packages/starters declare their own variable
  // defaults. The legacy localStorage "values" key still migrates via the
  // hasStored("values") check below.
  const startingValues = useMemo<VariableValues>(() => loadStored("values", {}), [loadStored]);
  const startingWorkspaceDrafts = useMemo<Record<string, string>>(
    () => loadStored("workspaceDrafts", {}),
    [loadStored],
  );
  const startingWorkspaceDraftFiles = useMemo<ConfigFile[] | null>(
    () => loadStored("workspaceDraftFiles", null),
    [loadStored],
  );
  const hasStartingLocalDraft = Object.keys(startingWorkspaceDrafts).length > 0
    || startingWorkspaceDraftFiles !== null
    || startingPrinters.some((record) => (
      Object.keys(record.workspaceDrafts ?? {}).length > 0
      || (record.workspaceDraftFiles !== null && record.workspaceDraftFiles !== undefined)
    ));
  const startingCloudRevision = useMemo(
    () => loadStored<string | null | undefined>("cloudAppStateRevision", undefined),
    [loadStored],
  );
  const startingLocalVariableValuesByPrinter = useMemo(() => {
    const valuesByPrinter = new Map<string, VariableValues>();
    for (const record of startingPrinters) {
      if (record.variableValues) {
        valuesByPrinter.set(record.id, record.variableValues);
      }
    }
    if (startingSelectedPrinterId && hasStored("values")) {
      valuesByPrinter.set(startingSelectedPrinterId, {
        ...(valuesByPrinter.get(startingSelectedPrinterId) ?? {}),
        ...startingValues,
      });
    }
    return valuesByPrinter;
  }, [hasStored, startingPrinters, startingSelectedPrinterId, startingValues]);
  const activeTab = tabFromPath(location.pathname);
  const setActiveTab = useCallback((tab: Tab) => {
    void navigate(tabPaths[tab]);
  }, [navigate]);
  const [selectedPackageId, setSelectedPackageId] = usePersistedState("selectedPackageId", "");
  const [selectedFilePath, setSelectedFilePath] = usePersistedState("selectedFilePath", "printer.cfg");
  const [history, setHistory] = useState<HistoryVersion[]>(startingHistory);
  const [printer, setPrinter] = useState<PrinterState>(() =>
    loadStored("printer", initialPrinter),
  );
  const [pendingConfigImport, setPendingConfigImport] = useState<PendingConfigImport | null>(null);
  const [workspaceFilePath, setWorkspaceFilePath] = usePersistedState("workspaceFilePath", "printer.cfg");
  const [workspaceContent, setWorkspaceContent] = useState(
    () =>
      loadStored(
        "workspaceContent",
        loadInitialWorkspaceContent(startingHistory, loadStored),
      ),
  );
  const [workspaceDrafts, setWorkspaceDrafts] = useState<Record<string, string>>(startingWorkspaceDrafts);
  // Draft file SET (not just content edits) — when non-null, this overrides
  // latestVersion as the working set of files. Cleared by recovery/fork flows.
  // Persists across reloads so structural edits
  // (import, create, rename, delete, starter) never get lost.
  const [workspaceDraftFiles, setWorkspaceDraftFiles] = useState<ConfigFile[] | null>(startingWorkspaceDraftFiles);
  const printerRef = useRef(printer);
  const workspaceContentRef = useRef(workspaceContent);
  const workspaceDraftFilesRef = useRef(workspaceDraftFiles);
  const workspaceDraftsRef = useRef(workspaceDrafts);
  const workspaceFilePathRef = useRef(workspaceFilePath);
  const workspaceOwnerPrinterIdRef = useRef(startingSelectedPrinterId);
  const workspaceMutationGenerationRef = useRef(0);
  const repositoryLoadSequenceRef = useRef(0);

  useEffect(() => {
    printerRef.current = printer;
  }, [printer]);
  useEffect(() => {
    workspaceContentRef.current = workspaceContent;
    workspaceDraftFilesRef.current = workspaceDraftFiles;
    workspaceDraftsRef.current = workspaceDrafts;
    workspaceFilePathRef.current = workspaceFilePath;
  }, [workspaceContent, workspaceDraftFiles, workspaceDrafts, workspaceFilePath]);

  const setTrackedWorkspaceContent = useCallback((content: string) => {
    workspaceMutationGenerationRef.current += 1;
    workspaceContentRef.current = content;
    setWorkspaceContent(content);
  }, []);
  const setTrackedWorkspaceDraftFiles = useCallback<Dispatch<SetStateAction<ConfigFile[] | null>>>((action) => {
    workspaceMutationGenerationRef.current += 1;
    const next = typeof action === "function" ? action(workspaceDraftFilesRef.current) : action;
    workspaceDraftFilesRef.current = next;
    setWorkspaceDraftFiles(next);
  }, []);
  const setTrackedWorkspaceDrafts = useCallback<Dispatch<SetStateAction<Record<string, string>>>>((action) => {
    workspaceMutationGenerationRef.current += 1;
    const next = typeof action === "function" ? action(workspaceDraftsRef.current) : action;
    workspaceDraftsRef.current = next;
    setWorkspaceDrafts(next);
  }, []);
  const setTrackedWorkspaceFilePath = useCallback((path: string) => {
    workspaceMutationGenerationRef.current += 1;
    workspaceFilePathRef.current = path;
    setWorkspaceFilePath(path);
  }, [setWorkspaceFilePath]);
  const setSynchronizedPrinter = useCallback<Dispatch<SetStateAction<PrinterState>>>((action) => {
    const next = typeof action === "function" ? action(printerRef.current) : action;
    printerRef.current = next;
    setPrinter(next);
    saveStored("printer", next);
  }, [saveStored]);
  // Bumped each time a consumer (e.g. a lint finding) asks the editor to
  // jump to a specific line. The editor reacts to the token, not the line
  // value, so repeated jumps to the same line still scroll.
  const [editorJumpTarget, setEditorJumpTarget] = useState<{ token: number; line: number } | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState("Ready");
  const [publishStatus, setPublishStatus] = useState("");
  const [bindStatus, setBindStatus] = useState("Select a printer and package");
  const [repositoryId, setRepositoryId] = usePersistedState<string | null>("repositoryId", null);
  const [repoStatus, setRepoStatus] = useState("Create a cloud repo when ready");
  const [privatePackages, setPrivatePackages] = usePersistedState<ConfigPackage[]>(
    "privatePackages",
    startingPrivatePackages,
  );
  const [privatePackageStatus, setPrivatePackageStatus] = useState("Sign in to sync private packages");
  const [companionAssetStatus, setCompanionAssetStatus] = useState("Sign in to sync companion assets");
  const [buildStatus, setBuildStatus] = useState("");
  const [packageDraft, setPackageDraft] = usePersistedState<PackageDraft>("packageDraft", {
    description: "Private reusable config package built from the current workspace.",
    hardware: "Klipper",
    printer: "",
    tags: "private, imported",
    title: "Private printer package",
  });
  const {
    authChecked,
    authStatus,
    authUser,
    cloudStatus,
    loginOpen,
    logout: logoutInternal,
    setCloudStatus,
    setLoginOpen,
  } = authSession;
  const [cloudBootstrapUserId, setCloudBootstrapUserId] = useState<string | null>(null);
  const cloudStateReady = !authUser || cloudBootstrapUserId === authUser.id;

  const {
    addPrinterDraft,
    adoptSelectedPrinterId,
    cancelDeletePrinter,
    closePrinterDetailsEditor,
    confirmDeletePrinter,
    creatingPrinter,
    loadPrintersFromCloud,
    openPrinterDetailsEditor,
    pendingDeletePrinterId,
    printerCloudQueue,
    printerDetailsDraft,
    printerDetailsEditorId,
    printerLoadFailed,
    printerPickerOpen,
    printerStatus,
    printers,
    printersRef,
    requestDeletePrinter,
    savePrinterDetails,
    selectPrinter,
    selectedPrinter,
    selectedPrinterId,
    selectedPrinterIdRef,
    setPrinterDetailsDraft,
    setPrinterPickerOpen,
    setSynchronizedPrinters,
    startPrinterDraftFromCatalog,
    switchingPrinterId,
    updatePrinterDetails,
    updatePrinterLocally,
    updatePrinterRecord,
    updateVariable,
    values,
  } = usePrinters({
    activeTab,
    authUser,
    getWorkspaceSnapshot,
    initialPrinters: startingPrinters,
    initialSelectedPrinterId: startingSelectedPrinterId,
    initialValues: startingValues,
    loadRepositoryHistory,
    // The sync-token callbacks close over consts destructured from
    // useRepositorySync below; they are only invoked from event handlers and
    // async continuations, after this render body has finished.
    loadSyncTokens: (targetRepositoryId) => loadSyncTokens(targetRepositoryId),
    onRepositoryChange: handleRepositoryChange,
    resetWorkspace: resetWorkspaceForNoPrinter,
    restoreWorkspaceForPrinter: restoreLocalPrinterWorkspace,
    seedStarterWorkspace,
    setCloudStatus,
    setPackageDraft,
    setRepoStatus,
    setSyncStatus: (status) => setSyncStatus(status),
    setSyncTokens: (tokens) => setSyncTokens(tokens),
    updatePrinterState,
  });

  async function logout() {
    if (!await logoutInternal()) {
      return;
    }
    // Invalidate reads and queued writes immediately after the server accepts
    // logout; do not wait for the auth state re-render to close that window.
    printerCloudQueue.setAuthUserId(null);
    setCloudBootstrapUserId(null);
    setCompanionAssetStatus("Sign in to sync companion assets");
    setPrivatePackageStatus("Sign in to sync private packages");
  }

  const {
    catalogStatus,
    packageCatalog,
    registryQuery,
    registryTag,
    selectPackage: selectPackageFromCatalog,
    setCatalogStatus,
    setPackageCatalog,
    setRegistryQuery,
    setRegistryTag,
    upsertPublicPackage,
  } = usePublicPackageCatalog({
    setSelectedFilePath,
    setSelectedPackageId,
  });

  const {
    browserZipAvailable,
    filteredPackages,
    fullPackageCatalog,
    missingVariables,
    packageDownloadUrl,
    registryTags,
    renderLimitExceeded,
    renderedFile,
    renderedFiles,
    selectedFile,
    selectedPackage,
    variableErrors,
  } = useSelectedPackage({
    packageCatalog,
    privatePackages,
    registryQuery,
    registryTag,
    selectedFilePath,
    selectedPackageId,
    setPackageCatalog,
    setPrivatePackages,
  }, values);
  const {
    companionAssetDraft,
    companionAssets,
    editingCompanionAssetId,
    addImportedCompanionAssets,
    assignCompanionAssetsToPrinter: assignCompanionAssetsToPrinterLocally,
    deleteCompanionAsset: deleteCompanionAssetLocally,
    loadCompanionAssetForEdit,
    saveCompanionAsset: saveCompanionAssetLocally,
    selectedCompanionAsset,
    selectedCompanionAssetId,
    setCompanionAssets,
    setSelectedCompanionAssetId,
    startNewCompanionAsset,
    updateCompanionAssetDraft,
    updateCompanionAssetStructured,
  } = useCompanionAssets(startingCompanionAssets, null);
  const pendingCompanionWrites = useRef(new Map<string, number>());
  const deleteCompanionAsset = useCompanionAssetDeletion({
    authUser, assets: companionAssets, isBusy: id => pendingCompanionWrites.current.has(id),
    setStatus: setCompanionAssetStatus,
    removeLocal: id => {
      deleteCompanionAssetLocally(id);
      setPrivatePackages(current => current.map(pkg => pkg.companionAssetIds?.includes(id)
        ? { ...pkg, companionAssetIds: pkg.companionAssetIds.filter(assetId => assetId !== id) } : pkg));
    },
  });
  const linkedCompanionAssets = useMemo(
    () => companionAssets.filter((asset) => selectedPackage?.companionAssetIds?.includes(asset.id)),
    [companionAssets, selectedPackage],
  );
  const activeRepositoryId = selectedPrinter ? selectedPrinter.repositoryId ?? null : repositoryId;
  const latestVersion = history[history.length - 1] ?? null;
  const appliedVersion = history.find((version) => version.id === printer.appliedVersionId) ?? null;
  const {
    currentWorkspaceContent,
    currentWorkspaceFile,
    historyChangedPaths,
    missingIncludePaths,
    packageVariables,
    pendingWorkspaceFiles,
    safetyBlocked,
    safetyFindings,
    workspaceChanged,
  } = useWorkspaceAnalysis({
    history,
    latestVersion,
    workspaceContent,
    workspaceDrafts,
    workspaceDraftFiles,
    workspaceFilePath,
  });
  const {
    buildDesktopInstallCommand,
    buildPrinterInstallCommand,
    clearSyncConflict,
    pauseSyncForReview,
    pauseRepositoryStaging,
    rememberWorkspaceBaseline,
    createCloudRepository,
    createDesktopSyncToken,
    createPrinterSyncToken,
    linkCurrentPrinter,
    loadSyncTokens,
    pendingConfiguration,
    stageRepositoryConfig,
    refreshSyncStatus,
    revokeSyncToken,
    setSyncStatus,
    setSyncTokens,
    clientInstallCommand,
    syncCheckedAt,
    syncConflict,
    syncPullUrl,
    syncStatus,
    syncToken,
    syncTokens,
  } = useRepositorySync({
    activeRepositoryId,
    authUser,
    bindRepositoryToSelectedPrinter,
    latestVersion,
    printer,
    selectedPrinter,
    setPrinter: setSynchronizedPrinter,
    setPrinters: setSynchronizedPrinters,
    setRepoStatus,
  });
  function getWorkspaceReviewSnapshot() {
      const record = printersRef.current.find(candidate => candidate.id === selectedPrinterIdRef.current);
      if (!authUser || !record?.repositoryId || workspaceOwnerPrinterIdRef.current !== record.id) return null;
      const baseHistoryFiles = latestVersion?.files ?? record.history?.[record.history.length - 1]?.files ?? [];
      return {
        scope: `${authUser.id}:${record.id}:${record.repositoryId}`,
        repositoryId: record.repositoryId,
        generation: workspaceMutationGenerationRef.current,
        files: effectiveLocalWorkspaceFiles(workspaceDraftFilesRef.current, workspaceDraftsRef.current,
          baseHistoryFiles),
        baselineRevision: record.workspaceBaseRevision,
        baselineFiles: record.workspaceBaseFiles ?? baseHistoryFiles,
      };
  }
  function adoptStagedWorkspace(files: ConfigFile[], revision: string, preferredPath?: string) {
      if (!activeRepositoryId || !files.length) return;
      const file = files.find(candidate => candidate.path === (preferredPath ?? workspaceFilePathRef.current)) ?? files[0];
      workspaceMutationGenerationRef.current += 1;
      commitWorkspaceState({ content: file.content, draftFiles: files, drafts: {}, filePath: file.path,
        history, ownerPrinterId: selectedPrinterIdRef.current });
      rememberWorkspaceBaseline(activeRepositoryId, revision, files);
      updatePrinterLocally(selectedPrinterIdRef.current, candidate => ({ ...candidate,
        workspaceBaseRevision: revision, workspaceBaseFiles: files, workspaceDraftFiles: files,
        workspaceDrafts: {}, workspaceFilePath: file.path,
      }));
      clearSyncConflict();
      setRepoStatus("Reviewed configuration staged for printer apply");
  }
  const reviewScope = `${authUser?.id}:${selectedPrinterId}:${activeRepositoryId}`;
  const {
    workspaceConflictReview, workspaceConflictBusy, workspaceConflictStatus,
    reviewWorkspaceConflict: loadWorkspaceConflictReview, resolveWorkspaceConflict, closeWorkspaceConflictReview,
  } = useWorkspaceConflict({
    scope: reviewScope, getSnapshot: getWorkspaceReviewSnapshot,
    stage: (id, files, revision) => stageRepositoryConfig(id, files, { baseRevision: revision }),
    adopt: adoptStagedWorkspace,
  });
  const {
    historyFileRestoreReview, historyFileRestoreBusy, historyFileRestoreStatus,
    reviewHistoryFileRestore, confirmHistoryFileRestore, cancelHistoryFileRestore,
  } = useHistoryFileRestore({
    scope: reviewScope, getSnapshot: getWorkspaceReviewSnapshot,
    pause: pauseRepositoryStaging, conflict: pauseSyncForReview,
    stage: (id, files, revision) => stageRepositoryConfig(id, files, { baseRevision: revision }),
    adopt: adoptStagedWorkspace,
  });
  async function reviewWorkspaceConflict() {
    pauseSyncForReview();
    await loadWorkspaceConflictReview();
  }
  const { currentCloudState, setCloudStateRevision } = useCloudAppState({
    authUser,
    cloudStateReady,
    currentWorkspaceContent,
    history,
    printer,
    printers,
    repositoryId: activeRepositoryId,
    selectedFilePath,
    selectedCompanionAssetId,
    selectedPackageId,
    selectedPrinterId,
    setCloudStatus,
    setDraftSavedAt,
    workspaceChanged,
    workspaceBaseRevision: selectedPrinter?.workspaceBaseRevision,
    workspaceDrafts,
    workspaceFilePath,
    flushLocalState: localStorageStatus.flush,
    initialCloudRevision: startingCloudRevision,
    onCloudRevision: (revision) => saveStored("cloudAppStateRevision", revision),
  });
  const {
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
  } = useWorkspaceActions({
    currentWorkspaceFile,
    pendingConfigImport,
    pendingWorkspaceFiles,
    selectedPrinter,
    setBuildStatus,
    setPackageDraft,
    setPendingConfigImport,
    setWorkspaceContent: setTrackedWorkspaceContent,
    setWorkspaceDrafts: setTrackedWorkspaceDrafts,
    setWorkspaceDraftFiles: setTrackedWorkspaceDraftFiles,
    setWorkspaceFilePath: setTrackedWorkspaceFilePath,
    getWorkspaceContext: () => ({
      generation: workspaceMutationGenerationRef.current,
      ownerPrinterId: workspaceOwnerPrinterIdRef.current,
      selectedPrinterId: selectedPrinterIdRef.current,
    }),
    workspaceDrafts,
    workspaceFilePath,
  });
  const {
    bindSelectedPackageToPrinter,
    buildPackageFromWorkspace,
    convertSelectionToVariable,
    publishSelectedPackage,
    publishWorkspacePackage,
    unbindPackageFromPrinter,
    forgetDeletedPrivatePackage,
    updatePublicPackageListing,
    updatePackageDraft,
  } = usePackageActions({
    authUser,
    packageDraft,
    packageVariables,
    pendingWorkspaceFiles,
    privatePackages,
    repositoryId: activeRepositoryId,
    safetyBlocked,
    selectedPackage,
    selectedPrinter,
    setActiveTab,
    setBindStatus,
    setBuildStatus,
    setCatalogStatus,
    setPackageDraft,
    setPrivatePackageStatus,
    setPrivatePackages,
    setPublishStatus,
    setSelectedFilePath,
    setSelectedPackageId,
    updatePrinterRecord,
    upsertPublicPackage,
    updateVariable,
    replaceWorkspaceDraftFiles,
  });

  function updatePrinterState(update: (current: PrinterState) => PrinterState) {
    const next = update(printerRef.current);
    setSynchronizedPrinter(next);
    return next;
  }

  /** Adopt a repository binding (the setter persists). */
  function handleRepositoryChange(nextRepositoryId: string | null) {
    setRepositoryId(nextRepositoryId);
  }

  /**
   * Snapshot of the live workspace for the outgoing printer record. The
   * workspace slices come from the refs — they are written synchronously by
   * the tracked setters, so they are strictly fresher than this render's
   * closure state.
   */
  function getWorkspaceSnapshot(): PrinterWorkspaceSnapshot {
    return {
      history,
      workspaceDraftFiles: workspaceDraftFilesRef.current,
      workspaceDrafts: workspaceDraftsRef.current,
      workspaceFilePath: workspaceFilePathRef.current,
    };
  }

  /** Seed the workspace draft files from a catalog starter config. */
  function seedStarterWorkspace(starter: StarterConfig) {
    const seedFiles = starter.files.map((file) => ({ ...file }));
    setTrackedWorkspaceDraftFiles(seedFiles);
    saveStored("workspaceDraftFiles", seedFiles);
    const firstFile = seedFiles.find((file) => file.path === "printer.cfg") ?? seedFiles[0];
    if (firstFile) {
      setTrackedWorkspaceFilePath(firstFile.path);
      setTrackedWorkspaceContent(firstFile.content);
      saveStored("workspaceContent", firstFile.content);
    }
  }

  /** Reset the workspace to empty after the last printer is deleted. */
  function resetWorkspaceForNoPrinter() {
    workspaceMutationGenerationRef.current += 1;
    commitWorkspaceState({
      content: "",
      draftFiles: null,
      drafts: {},
      filePath: "printer.cfg",
      history: [],
      ownerPrinterId: "",
    });
  }

  /**
   * The shared "replace the whole workspace" choreography: owner + the five
   * workspace slices, each written to its ref, state, and account cache in
   * one synchronous pass. The storage module queues a durable batch. Does NOT
   * bump workspaceMutationGenerationRef —
   * callers that need staleness invalidation bump it themselves.
   */
  function commitWorkspaceState(next: {
    content: string;
    draftFiles: ConfigFile[] | null;
    drafts: Record<string, string>;
    filePath: string;
    history: HistoryVersion[];
    ownerPrinterId: string;
  }) {
    workspaceOwnerPrinterIdRef.current = next.ownerPrinterId;
    workspaceDraftFilesRef.current = next.draftFiles;
    workspaceDraftsRef.current = next.drafts;
    workspaceFilePathRef.current = next.filePath;
    workspaceContentRef.current = next.content;
    setHistory(next.history);
    saveStored("history", next.history);
    setWorkspaceDraftFiles(next.draftFiles);
    saveStored("workspaceDraftFiles", next.draftFiles);
    setWorkspaceDrafts(next.drafts);
    saveStored("workspaceDrafts", next.drafts);
    setWorkspaceFilePath(next.filePath);
    setWorkspaceContent(next.content);
    saveStored("workspaceContent", next.content);
  }

  function restoreLocalPrinterWorkspace(record: PrinterRecord) {
    const nextHistory = record.history ?? [];
    const latestLocalVersion = nextHistory[nextHistory.length - 1] ?? null;
    const nextDraftFiles = record.workspaceDraftFiles ?? null;
    const nextDrafts = record.workspaceDrafts ?? {};
    const nextFiles = nextDraftFiles ?? latestLocalVersion?.files ?? [];
    const nextFile = nextFiles.find((file) => file.path === record.workspaceFilePath) ?? nextFiles[0] ?? null;

    commitWorkspaceState({
      content: nextFile ? nextDrafts[nextFile.path] ?? nextFile.content : "",
      draftFiles: nextDraftFiles,
      drafts: nextDrafts,
      filePath: nextFile ? nextFile.path : "printer.cfg",
      history: nextHistory,
      ownerPrinterId: record.id,
    });
  }

  function applyCloudAppState(state: CloudState) {
    printerRef.current = state.printer;
    workspaceFilePathRef.current = state.workspaceFilePath;
    workspaceContentRef.current = state.workspaceContent;
    workspaceDraftsRef.current = {};
    setAndPersist(setHistory, "history", state.history);
    setAndPersist(setPrinter, "printer", state.printer);
    setWorkspaceFilePath(state.workspaceFilePath);
    setAndPersist(setWorkspaceContent, "workspaceContent", state.workspaceContent);
    setAndPersist(setWorkspaceDrafts, "workspaceDrafts", {});
    setSelectedFilePath(state.selectedFilePath);
    setSelectedPackageId(state.selectedPackageId);
    setRepositoryId(state.repositoryId ?? null);

    const restoredPrinters = state.printers?.map((record) => {
      const sanitized = { ...record };
      delete sanitized.variableValues;
      const localVariableValues = startingLocalVariableValuesByPrinter.get(record.id);
      return localVariableValues
        ? { ...sanitized, variableValues: { ...localVariableValues } }
        : sanitized;
    });
    if (restoredPrinters) {
      setSynchronizedPrinters(restoredPrinters);
    }
    if (state.selectedPrinterId !== undefined) {
      workspaceOwnerPrinterIdRef.current = state.selectedPrinterId;
      adoptSelectedPrinterId(state.selectedPrinterId);
    }
    if (state.selectedCompanionAssetId !== undefined) {
      setSelectedCompanionAssetId(state.selectedCompanionAssetId);
    }

    return {
      history: state.history,
      printer: state.printer,
      printers: restoredPrinters,
      repositoryId: state.repositoryId,
      selectedCompanionAssetId: state.selectedCompanionAssetId,
      selectedFilePath: state.selectedFilePath,
      selectedPackageId: state.selectedPackageId,
      selectedPrinterId: state.selectedPrinterId,
      workspaceContent: state.workspaceContent,
      workspaceFilePath: state.workspaceFilePath,
    } satisfies CloudState;
  }

  async function loadPrivatePackagesFromCloud() {
    const result = await cloudFetch("/api/private-packages", {
      onStatus: setPrivatePackageStatus,
      validate: parsePrivatePackagesResponse,
      messages: {
        pending: "Loading private packages",
        fail: "Private package load failed",
        error: "Private package load unavailable",
      },
    });
    if (!result.ok || !result.data) {
      return;
    }

    const packagesFromCloud = result.data.packages;
    setPrivatePackages(packagesFromCloud);
    setPrivatePackageStatus(
      packagesFromCloud.length === 0
        ? "No cloud private packages yet"
        : `Loaded ${packagesFromCloud.length} private package${packagesFromCloud.length === 1 ? "" : "s"}`,
    );
  }

  async function loadCompanionAssetsFromCloud() {
    const result = await cloudFetch("/api/companion-assets", {
      onStatus: setCompanionAssetStatus,
      validate: parseCompanionAssetsResponse,
      messages: {
        pending: "Loading companion assets",
        fail: "Companion asset load failed",
        error: "Companion asset load unavailable",
      },
    });
    if (!result.ok || !result.data) {
      return;
    }

    const assetsFromCloud = result.data.assets;
    setCompanionAssets(assetsFromCloud);
    setCompanionAssetStatus(
      assetsFromCloud.length === 0
        ? "No cloud companion assets yet"
        : `Loaded ${assetsFromCloud.length} companion asset${assetsFromCloud.length === 1 ? "" : "s"}`,
    );
  }

  async function loadExistingRepositoryAfterSignIn() {
    const result = await cloudFetch("/api/repos", {
      validate: parseRepoListResponse,
      onStatus: setRepoStatus,
      messages: { fail: "Repo lookup failed", error: "Repo lookup unavailable" },
    });
    if (!result.ok || !result.data) {
      return;
    }
    setRepoStatus(
      result.data.repositories.length ? "Create a repo for this printer" : "Create a cloud repo when ready",
    );
  }

  async function loadCloudAppStateAfterSignIn() {
    const result = await cloudFetch("/api/app-state", {
      validate: parseAppStateResponse,
      onStatus: setCloudStatus,
      messages: { fail: "Cloud state unavailable", error: "Cloud state unavailable" },
    });
    if (!result.ok || !result.data) {
      return null;
    }
    if (hasStartingLocalDraft && result.data.state !== null
      && (startingCloudRevision === undefined || startingCloudRevision !== result.data.revision)
      && !cloudAppStatesEqual(currentCloudState(), result.data.state)) {
      setCloudStatus("Local draft restored; the cloud backup changed in another session. Your draft has been kept on this device.");
      return null;
    }
    setCloudStateRevision(result.data.revision);
    if (result.data.state) {
      if (hasStartingLocalDraft) {
        setCloudStatus("Local draft restored; cloud autosave will resume");
        return null;
      }
      const restoredState = applyCloudAppState(result.data.state);
      setCloudStatus("Cloud state restored");
      return restoredState;
    }
    return null;
  }

  useEffect(() => {
    let active = true;
    if (!authChecked) {
      return () => {
        active = false;
      };
    }
    if (!authUser) {
      return () => {
        active = false;
      };
    }
    const bootstrapUserId = authUser.id;
    async function bootstrapCloudData() {
      // Switching printers is persisted locally immediately, while the legacy
      // cloud app-state snapshot may still contain the previous selection.
      // Capture the browser's explicit choice before app-state restoration so
      // a refresh cannot jump back to that stale cloud selection.
      const locallySelectedPrinterId = loadStored("selectedPrinterId", "");
      const restoredState = await loadCloudAppStateAfterSignIn();
      const secondaryLoads = Promise.all([
        loadExistingRepositoryAfterSignIn(),
        loadPrivatePackagesFromCloud(),
        loadCompanionAssetsFromCloud(),
      ]);
      await loadPrintersFromCloud(
        locallySelectedPrinterId || restoredState?.selectedPrinterId,
        restoredState?.selectedPrinterId,
        startingLocalVariableValuesByPrinter,
      );
      if (active) {
        setCloudBootstrapUserId(bootstrapUserId);
      }
      await secondaryLoads;
    }
    // Cloud app-state hydrates a new/clean browser scope. A real local draft
    // wins on a returning browser and resumes autosave after printer metadata
    // is reconciled.
    void bootstrapCloudData();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, authUser]);

  // Auto-stage the desired configuration to the linked repository on idle. This
  // is the config a printer pulls; a version is captured only when the printer
  // applies it (server-side). Unlinked/local workspaces just keep the working
  // draft and never stage.
  useEffect(() => {
    // After a 409 draft conflict the stale baseline would just fail again, so
    // auto-staging pauses until a repository reload refreshes the baseline.
    if (!authUser || !cloudStateReady || !activeRepositoryId || !workspaceChanged || safetyBlocked || syncConflict || workspaceConflictReview || workspaceConflictBusy || historyFileRestoreReview || historyFileRestoreBusy) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void stageRepositoryConfig(activeRepositoryId, pendingWorkspaceFiles);
    }, 1500);
    return () => window.clearTimeout(timer);
    // Stage in reaction to draft edits, mirroring the draft autosave trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, cloudStateReady, activeRepositoryId, workspaceChanged, safetyBlocked, syncConflict, workspaceConflictReview, workspaceConflictBusy, historyFileRestoreReview, historyFileRestoreBusy, workspaceDrafts, workspaceFilePath]);

  async function loadRepositoryHistory(
    targetRepositoryId: string,
    printerName: string,
    workspaceRecord?: PrinterRecord,
  ) {
    const loadSequence = repositoryLoadSequenceRef.current + 1;
    repositoryLoadSequenceRef.current = loadSequence;
    const requestedPrinterId = workspaceRecord?.id ?? selectedPrinterIdRef.current;
    const workspaceGeneration = workspaceMutationGenerationRef.current;
    const authGeneration = printerCloudQueue.generation;
    const authUserId = printerCloudQueue.authUserId;

    function shouldDiscardLoad() {
      if (
        printerCloudQueue.generation !== authGeneration
        || printerCloudQueue.authUserId !== authUserId
      ) {
        return true;
      }
      if (repositoryLoadSequenceRef.current !== loadSequence) {
        return true;
      }
      if (requestedPrinterId && selectedPrinterIdRef.current !== requestedPrinterId) {
        return true;
      }
      const currentRecord = requestedPrinterId
        ? printersRef.current.find((candidate) => candidate.id === requestedPrinterId)
        : null;
      if (requestedPrinterId && (!currentRecord || currentRecord.repositoryId !== targetRepositoryId)) {
        return true;
      }
      if (workspaceMutationGenerationRef.current !== workspaceGeneration) {
        setRepoStatus("Kept newer local workspace changes");
        return true;
      }
      return false;
    }

    function reportRepositoryLoadStatus(status: string) {
      if (
        repositoryLoadSequenceRef.current === loadSequence
        && printerCloudQueue.generation === authGeneration
        && printerCloudQueue.authUserId === authUserId
        && workspaceMutationGenerationRef.current === workspaceGeneration
        && (!requestedPrinterId || selectedPrinterIdRef.current === requestedPrinterId)
      ) {
        setRepoStatus(status);
      }
    }

    const result = await cloudFetch(
      `/api/repos/${targetRepositoryId}/versions?format=content-addressed`,
      {
        onStatus: reportRepositoryLoadStatus,
        validate: verifyRepositoryVersionsResponse,
        messages: {
          pending: "Loading cloud config history",
          fail: "Cloud config history load failed",
          error: "Cloud config history unavailable",
        },
      },
    );
    if (!result.ok || !result.data) {
      return;
    }
    if (shouldDiscardLoad()) {
      return;
    }
    const responseData = result.data;

    const cloudVersions = sortCloudVersions(responseData.versions);
    const latestCloudFiles = cloudVersions[cloudVersions.length - 1]?.files ?? [];
    const activeWorkspaceRecord = requestedPrinterId
      ? printersRef.current.find((candidate) => candidate.id === requestedPrinterId) ?? workspaceRecord
      : workspaceRecord;
    const useLiveWorkspace = Boolean(
      requestedPrinterId
      && selectedPrinterIdRef.current === requestedPrinterId
      && workspaceOwnerPrinterIdRef.current === requestedPrinterId,
    );
    const desiredConfiguration = responseData.desired;
    const desiredDraft = desiredConfiguration?.pending ? desiredConfiguration : null;
    const localStructuralFiles = useLiveWorkspace
      ? workspaceDraftFilesRef.current
      : activeWorkspaceRecord?.workspaceDraftFiles ?? null;
    const localDrafts = useLiveWorkspace
      ? workspaceDraftsRef.current
      : activeWorkspaceRecord?.workspaceDrafts ?? {};
    const hasLocalWorkspace = hasLocalWorkspaceDraft(localStructuralFiles, localDrafts);
    const cachedLocalBaseFiles = activeWorkspaceRecord?.workspaceBaseFiles
      ?? (desiredConfiguration && activeWorkspaceRecord?.workspaceBaseRevision === desiredConfiguration.revision
        ? desiredConfiguration.files : useLiveWorkspace && selectedPrinter?.id === requestedPrinterId
          ? latestVersion?.files : activeWorkspaceRecord?.history?.[activeWorkspaceRecord.history.length - 1]?.files);
    const localBaseFiles = cachedLocalBaseFiles ?? latestCloudFiles;
    const localEffectiveFiles = effectiveLocalWorkspaceFiles(
      localStructuralFiles,
      localDrafts,
      localBaseFiles,
    );
    const [latestRevision, localRevision, localBaseRevision] = await Promise.all([
      cloudVersions.length > 0 ? repositoryFilesRevision(latestCloudFiles) : Promise.resolve(null),
      hasLocalWorkspace ? repositoryFilesRevision(localEffectiveFiles) : Promise.resolve(null),
      activeWorkspaceRecord?.workspaceBaseRevision === undefined && hasLocalWorkspace
        ? cachedLocalBaseFiles ? repositoryFilesRevision(cachedLocalBaseFiles) : Promise.resolve(null)
        : Promise.resolve(activeWorkspaceRecord?.workspaceBaseRevision),
    ]);
    if (shouldDiscardLoad()) {
      return;
    }

    if (syncConflict && activeRepositoryId === targetRepositoryId && selectedPrinter?.id === requestedPrinterId
      && hasLocalWorkspace && localRevision !== desiredConfiguration?.revision) {
      setRepoStatus("Local edits preserved. Review the draft conflict before reloading this workspace.");
      return;
    }

    const reconciled = reconcileRepositoryWorkspace({
      cloudVersions,
      desired: desiredConfiguration,
      localBaseRevision,
      localDrafts,
      localBaseFiles,
      localStructuralFiles,
      latestRevision,
      localRevision,
      preferredPath: useLiveWorkspace
        ? workspaceFilePathRef.current
        : activeWorkspaceRecord?.workspaceFilePath ?? "printer.cfg",
    });
    const nextHistory = reconciled.history;

    updatePrinterState((current) => ({
      ...current,
      latestVersionId: nextHistory[nextHistory.length - 1]?.id ?? 0,
      name: printerName,
    }));
    commitWorkspaceState({
      content: reconciled.content,
      draftFiles: reconciled.draftFiles,
      drafts: reconciled.drafts,
      filePath: reconciled.filePath,
      history: nextHistory,
      ownerPrinterId: requestedPrinterId,
    });
    // The reload established a fresh baseline, so a prior 409 draft conflict
    // no longer applies and auto-staging may resume.
    if (!syncConflict || localRevision === desiredConfiguration?.revision) clearSyncConflict();
    if (requestedPrinterId) {
      updatePrinterLocally(requestedPrinterId, (candidate) => ({
        ...candidate,
        workspaceBaseRevision: reconciled.workspaceBaseRevision,
        workspaceBaseFiles: desiredConfiguration && reconciled.workspaceBaseRevision === desiredConfiguration.revision
          ? desiredConfiguration.files : reconciled.workspaceBaseRevision === latestRevision
            ? latestCloudFiles : reconciled.workspaceBaseRevision === localBaseRevision && cachedLocalBaseFiles
              ? cachedLocalBaseFiles : candidate.workspaceBaseFiles,
        workspaceDraftFiles: reconciled.draftFiles,
        workspaceDrafts: reconciled.drafts,
        workspaceFilePath: reconciled.filePath,
      }));
    }
    setRepoStatus(desiredDraft
      ? nextHistory.length > 0
        ? `Loaded ${nextHistory.length} cloud version${nextHistory.length === 1 ? "" : "s"} and current desired draft`
        : "Loaded current desired draft; no applied versions yet"
      : nextHistory.length > 0
        ? `Loaded ${nextHistory.length} cloud version${nextHistory.length === 1 ? "" : "s"}`
        : "Cloud repo has no versions yet");
  }

  async function loadActiveRepositoryHistory() {
    if (syncConflict) { await reviewWorkspaceConflict(); return; }
    if (!activeRepositoryId) {
      setRepoStatus("Create a cloud repo first");
      return;
    }

    await loadRepositoryHistory(activeRepositoryId, selectedPrinter?.name ?? printer.name);
  }

  function selectPackage(id: string) {
    selectPackageFromCatalog(id, fullPackageCatalog);
  }

  function linkSelectedCompanionAssetToPackage() {
    if (!selectedPackage || !selectedCompanionAsset) {
      return;
    }
    if (!privatePackages.some((pkg) => pkg.id === selectedPackage.id)) {
      return;
    }

    setPrivatePackages((current) => {
      const next = current.map((pkg) => {
        if (pkg.id !== selectedPackage.id) {
          return pkg;
        }
        const companionAssetIds = new Set(pkg.companionAssetIds ?? []);
        companionAssetIds.add(selectedCompanionAsset.id);
        return {
          ...pkg,
          companionAssetIds: Array.from(companionAssetIds),
        };
      });
      return next;
    });
  }

  function jumpToLine(path: string, line: number) {
    // Switch to the target file (if different) and bump the jump token so the
    // editor scrolls + highlights.
    if (path && path !== workspaceFilePath) {
      const file = pendingWorkspaceFiles.find((candidate) => candidate.path === path);
      if (file) {
        selectWorkspaceFile(file);
      }
    }
    setEditorJumpTarget((current) => ({ token: (current?.token ?? 0) + 1, line }));
  }

  function selectPreviewFile(path: string) {
    setSelectedFilePath(path);
  }

  /** Include queued imports so a later save cannot undo an earlier deletion. */
  function markCompanionWrites(ids: string[], delta: 1 | -1) {
    for (const id of ids) {
      const pending = (pendingCompanionWrites.current.get(id) ?? 0) + delta;
      if (pending > 0) pendingCompanionWrites.current.set(id, pending);
      else pendingCompanionWrites.current.delete(id);
    }
  }

  /** Replace one asset in the list with its cloud-saved counterpart. */
  function replaceSavedCompanionAsset(id: string, saved: CompanionAsset) {
    setCompanionAssets((current) => current.map((candidate) => (
      candidate.id === id ? saved : candidate
    )));
  }

  /** POST one asset to the cloud and adopt the stored copy on success. */
  async function pushCompanionAssetToCloud(
    asset: CompanionAsset,
    messages: { pending: string; fail: string; error: string },
  ) {
    markCompanionWrites([asset.id], 1);
    try {
      const result = await cloudFetch("/api/companion-assets", {
        method: "POST",
        json: { asset },
        onStatus: setCompanionAssetStatus,
        validate: parseCompanionAssetResponse,
        messages,
      });
      if (!result.ok || !result.data) {
        return false;
      }
      replaceSavedCompanionAsset(asset.id, result.data.asset);
      return true;
    } finally {
      markCompanionWrites([asset.id], -1);
    }
  }

  async function saveCompanionAsset() {
    const asset = saveCompanionAssetLocally();
    if (!asset) {
      return;
    }

    if (!authUser) {
      setCompanionAssetStatus("Saved locally");
      return;
    }

    const synced = await pushCompanionAssetToCloud(asset, {
      pending: "Saving companion asset",
      fail: "Companion asset save failed",
      error: "Companion asset save unavailable",
    });
    if (synced) {
      setCompanionAssetStatus("Saved to cloud");
    }
  }

  async function importCompanionAssets(inputs: CompanionAssetImport[]) {
    const created = addImportedCompanionAssets(inputs);
    if (!created.length) return;

    if (!authUser) {
      setCompanionAssetStatus(`Imported ${created.length} preset${created.length === 1 ? "" : "s"} locally`);
      return;
    }

    const queuedIds = created.map(asset => asset.id);
    markCompanionWrites(queuedIds, 1);
    let saved = 0;
    try {
      for (const asset of created) {
        const synced = await pushCompanionAssetToCloud(asset, {
          pending: `Uploading ${asset.title}`,
          fail: "Preset upload failed",
          error: "Preset upload unavailable",
        });
        if (synced) {
          saved += 1;
        }
      }
    } finally { markCompanionWrites(queuedIds, -1); }
    setCompanionAssetStatus(`Imported ${created.length} preset${created.length === 1 ? "" : "s"} (${saved} synced)`);
  }

  async function assignCompanionAssetsToPrinter(printerId: string, ids: string[]) {
    const updated = assignCompanionAssetsToPrinterLocally(printerId, ids);
    if (!updated.length || !authUser) return;
    const queuedIds = updated.map(asset => asset.id);
    markCompanionWrites(queuedIds, 1);
    try {
      for (const asset of updated) {
        await pushCompanionAssetToCloud(asset, {
          pending: `Assigning ${asset.title}`,
          fail: "Preset assignment failed",
          error: "Preset assignment unavailable",
        });
      }
    } finally { markCompanionWrites(queuedIds, -1); }
  }

  async function publishSelectedCompanionAsset() {
    if (!authUser) {
      setCompanionAssetStatus("Sign in to publish assets");
      return;
    }
    if (!selectedCompanionAsset) {
      setCompanionAssetStatus("Select an asset to publish");
      return;
    }

    const publishingAssetId = selectedCompanionAsset.id;
    markCompanionWrites([publishingAssetId], 1);
    try {
      const result = await cloudFetch(
        `/api/companion-assets/${encodeURIComponent(selectedCompanionAsset.id)}/publish`,
        {
          method: "POST",
          onStatus: setCompanionAssetStatus,
          validate: parseCompanionAssetResponse,
          messages: {
            pending: "Publishing companion asset",
            fail: "Companion asset publish failed",
            error: "Companion asset publish unavailable",
          },
        },
      );
      if (!result.ok || !result.data) {
        return;
      }
      replaceSavedCompanionAsset(selectedCompanionAsset.id, result.data.asset);
      setCompanionAssetStatus(result.data.shareUrl ? `Published: ${result.data.shareUrl}` : "Published");
    } finally {
      markCompanionWrites([publishingAssetId], -1);
    }
  }

  function bindRepositoryToSelectedPrinter(nextRepositoryId: string | null) {
    handleRepositoryChange(nextRepositoryId);
    if (!selectedPrinter) {
      return;
    }

    const repositoryChanged = selectedPrinter.repositoryId !== nextRepositoryId;
    if (repositoryChanged) {
      updatePrinterState((current) => ({
        ...current,
        appliedAt: null,
        appliedVersionId: 0,
        latestVersionId: 0,
      }));
    }

    updatePrinterRecord(selectedPrinter.id, (candidate) => ({
      ...candidate,
      appliedAt: repositoryChanged ? null : candidate.appliedAt,
      appliedVersionId: repositoryChanged ? 0 : candidate.appliedVersionId,
      latestVersionId: repositoryChanged ? 0 : candidate.latestVersionId,
      repositoryId: nextRepositoryId,
      updatedAt: new Date().toISOString(),
      workspaceBaseRevision: repositoryChanged ? undefined : candidate.workspaceBaseRevision,
      workspaceBaseFiles: repositoryChanged ? undefined : candidate.workspaceBaseFiles,
    }));
  }

  async function handleDownload() {
    if (!selectedPackage) {
      setDownloadState("Select or build a package first");
      return;
    }
    if (renderLimitExceeded) {
      setDownloadState("Rendered package is too large; shorten variable values");
      return;
    }

    const errors = validateVariables(selectedPackage, values);
    if (Object.keys(errors).length > 0) {
      setDownloadState("Resolve required values first");
      return;
    }

    const requestValues = declaredPackageVariableValues(selectedPackage, values);
    setDownloadState("Building zip with API");
    try {
      const response = await fetch(`/api/packages/${selectedPackage.id}/download.zip`, {
        body: JSON.stringify({ variables: requestValues }),
        headers: {
          accept: "application/zip, application/json",
          "content-type": "application/json",
        },
        method: "POST",
      });

      if (response.ok) {
        const blob = await response.blob();
        downloadBlob(blob, `${selectedPackage.name}-${selectedPackage.version}.zip`);
        setDownloadState("Downloaded");
        return;
      }

      if (response.headers.get("content-type")?.includes("application/json")) {
        const data = (await response.json()) as {
          error?: string;
          errors?: Record<string, string>;
          unresolvedVariables?: string[];
        };
        const firstError = Object.values(data.errors ?? {})[0];
        const firstUnresolved = data.unresolvedVariables?.[0];
        setDownloadState(firstError ?? (firstUnresolved ? `Missing ${firstUnresolved}` : data.error ?? "API render failed"));
        return;
      }

      setDownloadState(`API render failed (${response.status})`);
      return;
    } catch {
      setDownloadState("API unavailable, using local render");
    }

    const unresolved = renderedFiles.flatMap((file) => unresolvedVariables(file.content));
    if (unresolved.length > 0) {
      setDownloadState("Rendered files still contain unresolved variables");
      return;
    }

    setDownloadState("Building zip");
    try {
      const blob = await createPackageZip(selectedPackage, requestValues);
      downloadBlob(blob, `${selectedPackage.name}-${selectedPackage.version}.zip`);
      setDownloadState("Downloaded");
    } catch (error) {
      setDownloadState(
        error instanceof PackageRenderLimitError
          ? "Rendered package is too large; shorten variable values"
          : "Couldn't build the package zip",
      );
    }
  }

  async function deleteVersion(version: HistoryVersion) {
    if (history.length <= 1) {
      setRepoStatus("A repository must keep at least one version");
      return false;
    }

    if (activeRepositoryId) {
      const result = await cloudFetch(`/api/repos/${activeRepositoryId}/versions/${version.id}`, {
        method: "DELETE",
        onStatus: setRepoStatus,
        messages: {
          pending: `Deleting version ${version.id}`,
          fail: `Version ${version.id} could not be deleted`,
          error: "Version delete unavailable",
        },
      });
      if (!result.ok) return false;
    }

    const nextHistory = history
      .filter((candidate) => candidate.id !== version.id)
      .map((candidate) => candidate.previousId === version.id
        ? { ...candidate, previousId: version.previousId }
        : candidate);
    const nextLatest = nextHistory[nextHistory.length - 1];
    const fallbackVersion = [...nextHistory].reverse().find((candidate) => candidate.id < version.id) ?? nextHistory[0];
    const nextPointer = (current: number) => current === version.id ? fallbackVersion.id : current;

    setHistory(nextHistory);
    saveStored("history", nextHistory);
    updatePrinterState((current) => ({
      ...current,
      appliedVersionId: nextPointer(current.appliedVersionId),
      latestVersionId: nextLatest.id,
    }));
    if (selectedPrinter) {
      updatePrinterRecord(selectedPrinter.id, (candidate) => ({
        ...candidate,
        appliedVersionId: nextPointer(candidate.appliedVersionId),
        history: candidate.repositoryId ? undefined : nextHistory,
        latestVersionId: nextLatest.id,
        updatedAt: new Date().toISOString(),
      }));
    }

    if (version.id === latestVersion?.id && !workspaceDraftFiles) {
      const nextFile = nextLatest.files.find((file) => file.path === workspaceFilePath) ?? nextLatest.files[0];
      if (nextFile) {
        setTrackedWorkspaceFilePath(nextFile.path);
        setTrackedWorkspaceContent(nextFile.content);
        saveStored("workspaceContent", nextFile.content);
      }
    }
    setRepoStatus(`Deleted version ${version.id}`);
    return true;
  }

  async function forkFromVersion(version: HistoryVersion) {
    const forkVersion: HistoryVersion = {
      id: 1,
      previousId: null,
      message: `Fork from version ${version.id}`,
      source: "fork",
      createdAt: new Date().toISOString(),
      files: version.files,
    };
    const firstFile = forkVersion.files[0];

    setHistory([forkVersion]);
    saveStored("history", [forkVersion]);
    updatePrinterState((current) => ({
      ...current,
      appliedAt: null,
      appliedVersionId: 0,
      latestVersionId: 1,
    }));
    if (firstFile) {
      setTrackedWorkspaceFilePath(firstFile.path);
      setTrackedWorkspaceContent(firstFile.content);
      setTrackedWorkspaceDrafts({});
      saveStored("workspaceContent", firstFile.content);
      saveStored("workspaceDrafts", {});
    }
    if (!activeRepositoryId) {
      setRepoStatus(`Forked local version ${version.id}`);
      return;
    }

    const result = await cloudFetch(`/api/repos/${activeRepositoryId}/forks`, {
      method: "POST",
      json: {
        name: `${printer.name}-fork-v${version.id}`,
        title: `${printer.name} fork v${version.id}`,
        versionNumber: version.id,
      },
      onStatus: setRepoStatus,
      validate: parseForkResponse,
      messages: {
        pending: `Forking version ${version.id}`,
        fail: "Cloud fork failed; kept local fork",
        error: "Cloud fork failed; kept local fork",
      },
    });
    if (!result.ok || !result.data) {
      setRepoStatus("Cloud fork failed; kept local fork");
      return;
    }

    const { repository, version: forkedVersion } = result.data;
    const cloudFork: HistoryVersion = {
      createdAt: forkedVersion.created_at,
      files: forkedVersion.files,
      id: forkedVersion.version_number,
      message: forkedVersion.message,
      previousId: null,
      source: forkedVersion.source,
    };
    bindRepositoryToSelectedPrinter(repository.id);
    setHistory([cloudFork]);
    saveStored("history", [cloudFork]);
    setRepoStatus(`Forked to ${repository.name}`);
  }

  const protectedTabLocked = protectedTabs.has(activeTab) && !authUser;
  const protectedDataPending = protectedTabs.has(activeTab)
    && (!authChecked || Boolean(authUser && !cloudStateReady));

  // Every returned function goes through the latest-ref stable-handler bundle
  // so context values memoized on them never invalidate from identity churn.
  // Each call still reaches this render's closure (see useStableHandlers).
  const stableHandlers = useStableHandlers({
    addPrinterDraft,
    assignCompanionAssetsToPrinter,
    bindSelectedPackageToPrinter,
    buildDesktopInstallCommand,
    buildPackageFromWorkspace,
    buildPrinterInstallCommand,
    cancelConfigImportReplacement,
    cancelDeletePrinter,
    reviewHistoryFileRestore,
    confirmHistoryFileRestore,
    cancelHistoryFileRestore,
    closePrinterDetailsEditor,
    confirmConfigImportReplacement,
    confirmDeletePrinter,
    convertSelectionToVariable,
    createCloudRepository,
    createDesktopSyncToken,
    createPrinterSyncToken,
    createWorkspaceFile,
    deleteCompanionAsset,
    deleteVersion,
    deleteWorkspaceFile,
    deleteWorkspaceFolder,
    forkFromVersion,
    handleDownload,
    forgetDeletedPrivatePackage,
    importCompanionAssets,
    importWorkspaceFiles,
    jumpToLine,
    linkCurrentPrinter,
    linkSelectedCompanionAssetToPackage,
    loadActiveRepositoryHistory,
    reviewWorkspaceConflict,
    resolveWorkspaceConflict,
    closeWorkspaceConflictReview,
    loadCompanionAssetForEdit,
    loadPrintersFromCloud,
    logout,
    openPrinterDetailsEditor,
    publishSelectedCompanionAsset,
    publishSelectedPackage,
    publishWorkspacePackage,
    refreshSyncStatus,
    renameWorkspaceFile,
    renameWorkspaceFolder,
    requestDeletePrinter,
    revokeSyncToken,
    saveCompanionAsset,
    savePrinterDetails,
    selectPackage,
    selectPreviewFile,
    selectPrinter,
    selectWorkspaceFile,
    setActiveTab,
    setLoginOpen,
    setPrinterDetailsDraft,
    setPrinterPickerOpen,
    setRegistryQuery,
    setRegistryTag,
    setSelectedCompanionAssetId,
    setSelectedFilePath,
    startNewCompanionAsset,
    startPrinterDraftFromCatalog,
    unbindPackageFromPrinter,
    updateCompanionAssetDraft,
    updateCompanionAssetStructured,
    updatePackageDraft,
    updatePrinterDetails,
    updatePublicPackageListing,
    updateVariable,
    updateWorkspaceContent,
    useStarterConfig,
  });

  return {
    ...stableHandlers,
    activeTab,
    authStatus,
    loginOpen,
    authUser,
    protectedDataPending,
    protectedTabLocked,
    authChecked,
    companionAssetDraft,
    companionAssets,
    companionAssetStatus,
    bindStatus,
    selectedPrinter,
    selectedPackage,
    browserZipAvailable,
    catalogStatus,
    workspaceFilePath,
    downloadState,
    draftSavedAt,
    cloudStatus,
    currentWorkspaceContent,
    latestVersion,
    history,
    printer,
    missingIncludePaths,
    missingVariables,
    editorJumpTarget,
    packageDownloadUrl,
    pendingConfigImport,
    fullPackageCatalog,
    filteredPackages,
    printerLoadFailed,
    printerPickerOpen,
    printerStatus,
    printers,
    registryQuery,
    renderedFile,
    repoStatus,
    clientInstallCommand,
    switchingPrinterId,
    syncPullUrl,
    syncCheckedAt,
    syncConflict,
    workspaceConflictReview,
    workspaceConflictBusy,
    workspaceConflictStatus,
    historyFileRestoreReview,
    historyFileRestoreBusy,
    historyFileRestoreStatus,
    pendingConfiguration,
    syncStatus,
    syncToken,
    syncTokens,
    safetyBlocked,
    safetyFindings,
    values,
    variableErrors,
    workspaceChanged,
    creatingPrinter,
    pendingDeletePrinterId,
    registryTag,
    registryTags,
    selectedPackageId,
    privatePackageStatus,
    selectedFile,
    publishStatus,
    privatePackages,
    historyChangedPaths,
    buildStatus,
    packageDraft,
    pendingWorkspaceFiles,
    editingCompanionAssetId,
    linkedCompanionAssets,
    selectedCompanionAssetId,
    packageVariables,
    appliedVersion,
    printerDetailsEditorId,
    printerDetailsDraft,
  };
}
