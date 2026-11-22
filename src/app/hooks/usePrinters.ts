import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { cloudFetch } from "../cloudFetch";
import { parsePrintersResponse } from "../responseGuards";
import { createPrinterCloudQueue } from "../printerCloudQueue";
import {
  createPrinterRecord,
  reconcileCloudPrinters,
  snapshotPrinterWorkspace,
} from "../helpers";
import { useAccountStorage } from "../contexts/useAccountStorage";
import { usePersistedState } from "./usePersistedState";
import { initialPrinter } from "../../data";
import { type PrinterCatalogOption } from "../../orcaPrinterCatalog";
import { starterConfigs, type StarterConfig } from "../../starterConfigs";
import type { VariableValues } from "../../rendering";
import type { AuthUser, PackageDraft, PrinterRecord, SyncTokenRecord, Tab } from "../types";
import type { ConfigFile, HistoryVersion, PrinterState } from "../../types";

/** The live workspace slices a printer record snapshots when deactivated. */
export type PrinterWorkspaceSnapshot = {
  history: HistoryVersion[];
  workspaceDraftFiles: ConfigFile[] | null;
  workspaceDrafts: Record<string, string>;
  workspaceFilePath: string;
};

type UsePrintersOptions = {
  activeTab: Tab;
  authUser: AuthUser | null;
  /** Live workspace state for snapshotting into the outgoing printer record. */
  getWorkspaceSnapshot: () => PrinterWorkspaceSnapshot;
  initialPrinters: PrinterRecord[];
  initialSelectedPrinterId: string;
  initialValues: VariableValues;
  loadRepositoryHistory: (
    repositoryId: string,
    printerName: string,
    workspaceRecord?: PrinterRecord,
  ) => Promise<void>;
  loadSyncTokens: (repositoryId: string | null) => Promise<void>;
  /** Adopt the given repository binding (state + persistence). */
  onRepositoryChange: (repositoryId: string | null) => void;
  /** Reset the workspace to empty after the last printer is deleted. */
  resetWorkspace: () => void;
  restoreWorkspaceForPrinter: (record: PrinterRecord) => void;
  /** Seed the workspace draft from a catalog starter config. */
  seedStarterWorkspace: (starter: StarterConfig) => void;
  setCloudStatus: (status: string) => void;
  setPackageDraft: Dispatch<SetStateAction<PackageDraft>>;
  setRepoStatus: (status: string) => void;
  setSyncStatus: (status: string) => void;
  setSyncTokens: (tokens: SyncTokenRecord[]) => void;
  updatePrinterState: (update: (current: PrinterState) => PrinterState) => PrinterState;
};

/**
 * Owns the printer domain: the printer list and selection, per-printer
 * variable values, the create/details/delete flows, cloud reconciliation, and
 * the per-printer serialized cloud write queue. Workspace concerns stay with
 * the caller and are reached through exactly the callbacks in
 * {@link UsePrintersOptions}.
 */
export function usePrinters({
  activeTab,
  authUser,
  getWorkspaceSnapshot,
  initialPrinters,
  initialSelectedPrinterId,
  initialValues,
  loadRepositoryHistory,
  loadSyncTokens,
  onRepositoryChange,
  resetWorkspace,
  restoreWorkspaceForPrinter,
  seedStarterWorkspace,
  setCloudStatus,
  setPackageDraft,
  setRepoStatus,
  setSyncStatus,
  setSyncTokens,
  updatePrinterState,
}: UsePrintersOptions) {
  const { saveStored } = useAccountStorage();
  const [printers, setPrinters] = useState<PrinterRecord[]>(initialPrinters);
  // Persisted setters: every write lands in localStorage, so the manual
  // saveStored pairing disappears from the flows below.
  const [selectedPrinterId, setSelectedPrinterId] = usePersistedState("selectedPrinterId", initialSelectedPrinterId);
  const [values, setValues] = usePersistedState<VariableValues>("values", initialValues);
  const [creatingPrinter, setCreatingPrinter] = useState(() => !initialSelectedPrinterId);
  const [printerPickerOpen, setPrinterPickerOpen] = useState(false);
  const [pendingDeletePrinterId, setPendingDeletePrinterId] = useState("");
  const [printerDetailsEditorId, setPrinterDetailsEditorId] = useState("");
  const [printerDetailsDraft, setPrinterDetailsDraft] = useState({ description: "", name: "" });
  const [switchingPrinterId, setSwitchingPrinterId] = useState("");
  // Data, not copy: gates the silent tab-switch retry so printerStatus stays
  // purely presentational.
  const [printerLoadFailed, setPrinterLoadFailed] = useState(false);
  const [printerStatus, setPrinterStatus] = useState(() => {
    const selected = initialPrinters.find((candidate) => candidate.id === initialSelectedPrinterId);
    return selected ? "" : "Select a printer or add a new one";
  });
  const printerSwitchSequenceRef = useRef(0);
  const printerLoadSequenceRef = useRef(0);
  const printerMutationGenerationRef = useRef(0);
  const variableMutationSequenceRef = useRef(new Map<string, number>());
  const printersRef = useRef(printers);
  const selectedPrinterIdRef = useRef(selectedPrinterId);
  const valuesRef = useRef(values);
  const [printerCloudQueue] = useState(createPrinterCloudQueue);
  // A queued write must never cross an account/session boundary: adopt the
  // new session during render, before a promise microtask can resume with a
  // newly issued browser cookie. setAuthUserId invalidates on change only.
  printerCloudQueue.setAuthUserId(authUser?.id ?? null);

  useEffect(() => {
    printersRef.current = printers;
  }, [printers]);
  useEffect(() => {
    selectedPrinterIdRef.current = selectedPrinterId;
  }, [selectedPrinterId]);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);
  useEffect(() => () => {
    // The request already in flight cannot be recalled, but every operation
    // waiting behind it observes this generation change and is cancelled.
    printerCloudQueue.invalidate();
  }, [printerCloudQueue]);

  const selectedPrinter = printers.find((candidate) => candidate.id === selectedPrinterId) ?? null;

  const setSynchronizedPrinters = useCallback<Dispatch<SetStateAction<PrinterRecord[]>>>((action) => {
    const next = typeof action === "function" ? action(printersRef.current) : action;
    printerMutationGenerationRef.current += 1;
    printersRef.current = next;
    setPrinters(next);
    saveStored("printers", next);
  }, [saveStored]);

  async function savePrinterToCloud(record: PrinterRecord) {
    if (!authUser || printerCloudQueue.isDeleted(record.id)) {
      return false;
    }

    return printerCloudQueue.enqueue(record.id, async () => {
      if (printerCloudQueue.isDeleted(record.id)) {
        return false;
      }
      // Configuration bodies, recovery history and local values are managed
      // separately. Including them can make a metadata save exceed the API limit.
      const printerPayload = {
        id: record.id,
        name: record.name,
        description: record.description,
        make: record.make,
        model: record.model,
        source: record.source,
        definition: record.definition,
        packageIds: record.packageIds,
        repositoryId: record.repositoryId,
        createdAt: record.createdAt,
      };
      const result = await cloudFetch("/api/printers", {
        method: "POST",
        json: { printer: printerPayload },
        onStatus: setCloudStatus,
        messages: {
          ok: `Saved ${record.name} to cloud`,
          fail: "Cloud printer save failed",
          error: "Cloud printer save unavailable",
        },
      });
      return result.ok;
    });
  }

  async function deletePrinterFromCloud(id: string) {
    printerCloudQueue.markDeleted(id);
    if (!authUser) {
      return false;
    }

    return printerCloudQueue.enqueue(id, async () => {
      const result = await cloudFetch(`/api/printers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        onStatus: setCloudStatus,
        messages: {
          ok: "Printer deleted from cloud",
          fail: "Cloud printer delete failed",
          error: "Cloud printer delete unavailable",
        },
      });
      return result.ok;
    });
  }

  /**
   * The shared "activate printer" choreography: selection + repository binding
   * + variable values, each with its ref/state/localStorage triple. Callers
   * layer their own printer-state and status updates on top.
   */
  function activatePrinter(record: PrinterRecord | null) {
    const id = record?.id ?? "";
    selectedPrinterIdRef.current = id;
    setSelectedPrinterId(id);
    onRepositoryChange(record?.repositoryId ?? null);
    const nextValues = record?.variableValues ?? {};
    valuesRef.current = nextValues;
    setValues(nextValues);
  }

  /**
   * Adopt a restored selection (cloud app-state) without the repository or
   * variable-value choreography of {@link activatePrinter}.
   */
  function adoptSelectedPrinterId(id: string) {
    selectedPrinterIdRef.current = id;
    setSelectedPrinterId(id);
  }

  function updatePrinterLocally(id: string, update: (record: PrinterRecord) => PrinterRecord) {
    let updatedRecord: PrinterRecord | null = null;
    const next = printersRef.current.map((candidate) => {
      if (candidate.id !== id) {
        return candidate;
      }
      updatedRecord = update(candidate);
      return updatedRecord;
    });
    if (updatedRecord) {
      setSynchronizedPrinters(next);
    }
    return updatedRecord;
  }

  function updatePrinterRecord(
    id: string,
    update: (record: PrinterRecord) => PrinterRecord,
  ) {
    const updatedRecord = updatePrinterLocally(id, update);
    if (updatedRecord) {
      void savePrinterToCloud(updatedRecord);
    }
    return updatedRecord;
  }

  async function savePrinterVariableToCloud(
    printerId: string,
    name: string,
    value: string,
    mutationSequence: number,
  ) {
    if (!authUser || printerCloudQueue.isDeleted(printerId)) {
      return false;
    }

    return printerCloudQueue.enqueue(printerId, async () => {
      if (printerCloudQueue.isDeleted(printerId)) {
        return false;
      }
      const result = await cloudFetch<{
        printer?: PrinterRecord | null;
        stored?: boolean;
      }>(`/api/printers/${encodeURIComponent(printerId)}/variables/${encodeURIComponent(name)}`, {
        method: "PATCH",
        json: { value },
        onStatus: setCloudStatus,
        messages: {
          ok: `Saved ${name} for this printer`,
          fail: "Printer variable save failed",
          error: "Printer variable save unavailable",
        },
      });
      if (!result.ok || !result.data?.printer) {
        return false;
      }

      const cloudPrinter = result.data.printer;
      const currentRecord = printersRef.current.find((candidate) => candidate.id === printerId);
      if (!currentRecord) {
        return true;
      }
      const isLatestMutation = variableMutationSequenceRef.current.get(printerId) === mutationSequence;
      const optimisticValue = currentRecord.variableValues?.[name] ?? value;
      const responseValues = cloudPrinter.variableValues ?? {};
      const mergedResponseValues = { ...(currentRecord.variableValues ?? {}), ...responseValues };
      const nextVariableValues = result.data.stored === false
        ? { ...mergedResponseValues, [name]: optimisticValue }
        : mergedResponseValues;
      const mergedRecord: PrinterRecord = {
        ...currentRecord,
        ...cloudPrinter,
        companionAssetIds: currentRecord.companionAssetIds,
        history: currentRecord.history,
        variableValues: isLatestMutation ? nextVariableValues : currentRecord.variableValues,
        workspaceBaseRevision: currentRecord.workspaceBaseRevision,
        workspaceBaseFiles: currentRecord.workspaceBaseFiles,
        workspaceDraftFiles: currentRecord.workspaceDraftFiles,
        workspaceDrafts: currentRecord.workspaceDrafts,
        workspaceFilePath: currentRecord.workspaceFilePath,
      };
      updatePrinterLocally(printerId, () => mergedRecord);
      if (isLatestMutation && selectedPrinterIdRef.current === printerId) {
        valuesRef.current = nextVariableValues;
        setValues(nextVariableValues);
      }
      return true;
    });
  }

  function updateVariable(name: string, value: string) {
    const next = { ...valuesRef.current, [name]: value };
    valuesRef.current = next;
    setValues(next);
    const printerId = selectedPrinterIdRef.current;
    if (!printerId) {
      return;
    }
    updatePrinterLocally(printerId, (candidate) => ({
      ...candidate,
      updatedAt: new Date().toISOString(),
      variableValues: next,
    }));
    const mutationSequence = (variableMutationSequenceRef.current.get(printerId) ?? 0) + 1;
    variableMutationSequenceRef.current.set(printerId, mutationSequence);
    void savePrinterVariableToCloud(printerId, name, value, mutationSequence);
  }

  // When the user opens Setup or Printers after a failed printer load, retry
  // the load silently so the user doesn't have to refresh the page to recover
  // from a transient failure.
  useEffect(() => {
    if (!authUser) return;
    if (activeTab !== "Setup" && activeTab !== "Printers") return;
    if (!printerLoadFailed) return;
    void loadPrintersFromCloud();
    // Only react to tab switches; printerLoadFailed is the gate but we don't
    // want a re-fire when the flag flips mid-load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, authUser]);

  async function loadPrintersFromCloud(
    preferredSelectedPrinterId = selectedPrinterId,
    fallbackSelectedPrinterId = "",
    localVariableValuesByPrinter: ReadonlyMap<string, VariableValues> = new Map(),
  ) {
    const loadSequence = printerLoadSequenceRef.current + 1;
    printerLoadSequenceRef.current = loadSequence;
    const mutationGeneration = printerMutationGenerationRef.current;
    const selectedIdAtStart = selectedPrinterIdRef.current;
    const authGeneration = printerCloudQueue.generation;
    const authUserId = printerCloudQueue.authUserId;

    function shouldDiscardPrinterLoad() {
      return printerLoadSequenceRef.current !== loadSequence
        || printerMutationGenerationRef.current !== mutationGeneration
        || selectedPrinterIdRef.current !== selectedIdAtStart
        || printerCloudQueue.generation !== authGeneration
        || printerCloudQueue.authUserId !== authUserId;
    }

    function reportPrinterLoadStatus(status: string) {
      if (!shouldDiscardPrinterLoad()) {
        setPrinterStatus(status);
      }
    }

    const result = await cloudFetch("/api/printers", {
      onStatus: reportPrinterLoadStatus,
      validate: parsePrintersResponse,
      messages: {
        fail: "Couldn't load printers from cloud — will retry on next tab change",
        error: "Cloud printer load unavailable — will retry on next tab change",
      },
    });
    if (!result.ok || !result.data) {
      if (!result.ok && !shouldDiscardPrinterLoad()) {
        setPrinterLoadFailed(true);
      }
      return;
    }
    if (shouldDiscardPrinterLoad()) {
      return;
    }
    setPrinterLoadFailed(false);

    const cloudPrinters = result.data.printers;
    const nextPrinters = reconcileCloudPrinters(
      printersRef.current,
      cloudPrinters,
      localVariableValuesByPrinter,
    );
    setSynchronizedPrinters(nextPrinters);
    setPrinterStatus(
      cloudPrinters.length === 0
        ? "No cloud printers yet"
        : `Loaded ${cloudPrinters.length} cloud printer${cloudPrinters.length === 1 ? "" : "s"}`,
    );
    const selectedCloudPrinter =
      nextPrinters.find((record) => record.id === preferredSelectedPrinterId)
      ?? nextPrinters.find((record) => record.id === fallbackSelectedPrinterId)
      ?? nextPrinters[0]
      ?? null;
    if (selectedCloudPrinter) {
      // Variable values belong to a printer, so the dedicated printer API is
      // authoritative when it disagrees with the legacy app-state snapshot.
      // Without this, a refresh can restore stale values after an edit.
      const nextValues = selectedCloudPrinter.variableValues ?? {};
      valuesRef.current = nextValues;
      setValues(nextValues);
      selectedPrinterIdRef.current = selectedCloudPrinter.id;
      setSelectedPrinterId(selectedCloudPrinter.id);
    }
    if (selectedCloudPrinter?.repositoryId) {
      await loadRepositoryHistory(selectedCloudPrinter.repositoryId, selectedCloudPrinter.name, selectedCloudPrinter);
    }
  }

  async function selectPrinter(id: string) {
    if (!id || id === selectedPrinterId) {
      return;
    }

    const nextPrinter = printers.find((candidate) => candidate.id === id);
    if (!nextPrinter) {
      return;
    }

    const switchSequence = printerSwitchSequenceRef.current + 1;
    printerSwitchSequenceRef.current = switchSequence;

    if (selectedPrinter) {
      // Snapshot the outgoing workspace from the refs — they are written
      // synchronously by the tracked setters, so they are strictly fresher
      // than this render's closure state.
      const workspaceSnapshot = getWorkspaceSnapshot();
      updatePrinterRecord(selectedPrinter.id, (candidate) =>
        snapshotPrinterWorkspace(candidate, workspaceSnapshot),
      );
    }

    setSwitchingPrinterId(id);
    setPrinterStatus(`Loading ${nextPrinter.name} configs`);
    setRepoStatus("Switching printer workspace");
    setCreatingPrinter(false);
    activatePrinter(nextPrinter);
    updatePrinterState((current) => ({
      ...current,
      appliedAt: nextPrinter.appliedAt,
      appliedVersionId: nextPrinter.appliedVersionId,
      latestVersionId: nextPrinter.latestVersionId,
      name: nextPrinter.name,
    }));
    setRepoStatus(`Loading ${nextPrinter.name}`);
    void loadSyncTokens(nextPrinter.repositoryId ?? null);

    try {
      if (nextPrinter.repositoryId) {
        await loadRepositoryHistory(nextPrinter.repositoryId, nextPrinter.name, nextPrinter);
      } else {
        restoreWorkspaceForPrinter(nextPrinter);
        setRepoStatus("Create a repo for this printer");
      }
      setSyncStatus(nextPrinter.repositoryId ? "Refresh to check sync" : "Connect a cloud repo to check sync");
      setPrinterStatus("");
    } finally {
      if (printerSwitchSequenceRef.current === switchSequence) {
        setSwitchingPrinterId("");
      }
    }
  }

  function addPrinterDraft() {
    setPrinterPickerOpen(true);
  }

  function uniquePrinterName(baseName: string, ignorePrinterId = "") {
    const base = baseName.trim() || "Printer";
    const existingNames = new Set(
      printers
        .filter((candidate) => candidate.id !== ignorePrinterId)
        .map((candidate) => candidate.name.trim().toLowerCase()),
    );
    if (!existingNames.has(base.toLowerCase())) {
      return base;
    }

    for (let index = 2; ; index += 1) {
      const candidate = `${base} ${index}`;
      if (!existingNames.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }

  function generatedPrinterName(option: PrinterCatalogOption) {
    if (option.source === "custom") {
      return uniquePrinterName(`Printer ${printers.length + 1}`);
    }

    return uniquePrinterName(option.name || [option.make, option.model].filter(Boolean).join(" ") || "Printer");
  }

  function startPrinterDraftFromCatalog(
    option: PrinterCatalogOption,
    details: { description?: string; name?: string } = {},
  ) {
    const record = createPrinterRecord({
      description: details.description?.trim() ?? "",
      make: option.source === "custom" ? "" : option.make,
      model: option.source === "custom" ? "" : option.model,
      name: uniquePrinterName(details.name?.trim() || generatedPrinterName(option)),
      source: option.source === "custom" ? "manual" : "catalog",
    });

    const currentSelectedPrinterId = selectedPrinterIdRef.current;
    // Snapshot the outgoing workspace from the refs (via the snapshot
    // callback) — they are strictly fresher than this render's closure state.
    const workspaceSnapshot = currentSelectedPrinterId ? getWorkspaceSnapshot() : null;
    const preservedCurrent = currentSelectedPrinterId && workspaceSnapshot
      ? printersRef.current.map((candidate) =>
          candidate.id === currentSelectedPrinterId
            ? snapshotPrinterWorkspace(candidate, workspaceSnapshot)
            : candidate,
        )
      : printersRef.current;
    setSynchronizedPrinters([record, ...preservedCurrent]);
    void savePrinterToCloud(record);
    activatePrinter(record);
    setCreatingPrinter(false);
    setPrinterPickerOpen(false);
    setPendingDeletePrinterId("");
    updatePrinterState((current) => ({
      ...current,
      appliedVersionId: record.appliedVersionId,
      latestVersionId: record.latestVersionId,
      name: record.name,
    }));
    setPackageDraft((current) => ({ ...current, printer: record.name, title: `${record.name} package` }));
    setSyncTokens([]);
    restoreWorkspaceForPrinter(record);
    // Seed the matching starter as the printer's initial workspace draft when
    // the user picked a catalog kinematic template. Custom printers stay
    // empty — the user can import their own configs.
    if (option.source !== "custom" && option.starterConfigId) {
      const starter = starterConfigs.find((candidate) => candidate.id === option.starterConfigId);
      if (starter) {
        seedStarterWorkspace(starter);
        setPackageDraft((current) => ({
          ...current,
          description: starter.description,
          hardware: starter.tags.filter((tag) => tag !== "starter").join(", "),
          tags: Array.from(new Set(["private", ...starter.tags])).join(", "),
          title: `${record.name} ${starter.title}`,
        }));
      }
    }
    setPrinterStatus(`Created ${record.name}`);
    setRepoStatus("Create a repo for this printer");
    setSyncStatus("Connect a cloud repo to check sync");
  }

  function openPrinterDetailsEditor(id: string) {
    const record = printers.find((candidate) => candidate.id === id);
    if (!record) {
      return;
    }
    setPrinterDetailsEditorId(record.id);
    setPrinterDetailsDraft({ description: record.description, name: record.name });
  }

  function closePrinterDetailsEditor() {
    setPrinterDetailsEditorId("");
  }

  async function updatePrinterDetails(id: string, details: { description: string; name: string }) {
    const record = printersRef.current.find((candidate) => candidate.id === id);
    const name = details.name.trim();
    if (!record) {
      return false;
    }
    if (!name) {
      setPrinterStatus("Printer name is required");
      return false;
    }

    const nextRecord = {
      ...record,
      description: details.description.trim(),
      name: uniquePrinterName(name, record.id),
      updatedAt: new Date().toISOString(),
    };
    const authGeneration = printerCloudQueue.generation;
    const ok = await savePrinterToCloud(nextRecord);
    if (authGeneration !== printerCloudQueue.generation || printerCloudQueue.isDeleted(id)) {
      return false;
    }
    if (!ok) {
      setPrinterStatus("Could not save printer details. Try again.");
      return false;
    }
    setSynchronizedPrinters(
      printersRef.current.map((candidate) => candidate.id === id ? {
        ...candidate,
        name: nextRecord.name,
        description: nextRecord.description,
        updatedAt: nextRecord.updatedAt,
      } : candidate),
    );
    if (selectedPrinterIdRef.current === nextRecord.id) {
      updatePrinterState((current) => ({ ...current, name: nextRecord.name }));
      setPackageDraft((current) => ({ ...current, printer: nextRecord.name }));
    }
    setPrinterStatus(`Saved ${nextRecord.name}`);
    return true;
  }

  function savePrinterDetails() {
    const record = printers.find((candidate) => candidate.id === printerDetailsEditorId);
    if (!record) {
      closePrinterDetailsEditor();
      return;
    }
    if (!printerDetailsDraft.name.trim()) {
      setPrinterStatus("Printer name is required");
      return;
    }
    updatePrinterDetails(record.id, printerDetailsDraft);
    closePrinterDetailsEditor();
  }

  function requestDeletePrinter(id: string) {
    const nextPrinter = printers.find((candidate) => candidate.id === id);
    if (!nextPrinter) {
      return;
    }
    setPendingDeletePrinterId(id);
    setPrinterStatus(`Confirm deletion of ${nextPrinter.name}`);
  }

  function cancelDeletePrinter() {
    setPendingDeletePrinterId("");
    setPrinterStatus(selectedPrinter ? "" : "Select a printer or add a new one");
  }

  function confirmDeletePrinter(id: string) {
    const deletedPrinter = printersRef.current.find((candidate) => candidate.id === id);
    const remainingPrinters = printersRef.current.filter((candidate) => candidate.id !== id);
    setSynchronizedPrinters(remainingPrinters);
    setPendingDeletePrinterId("");

    if (selectedPrinterIdRef.current === id) {
      const nextPrinter = remainingPrinters[0] ?? null;
      activatePrinter(nextPrinter);
      setCreatingPrinter(!nextPrinter);
      updatePrinterState((current) => ({
        ...current,
        appliedVersionId: nextPrinter?.appliedVersionId ?? 0,
        latestVersionId: nextPrinter?.latestVersionId ?? 0,
        name: nextPrinter?.name ?? initialPrinter.name,
      }));
      void loadSyncTokens(nextPrinter?.repositoryId ?? null);
      if (nextPrinter?.repositoryId) {
        void loadRepositoryHistory(nextPrinter.repositoryId, nextPrinter.name, nextPrinter);
      } else if (nextPrinter) {
        restoreWorkspaceForPrinter(nextPrinter);
        setRepoStatus("Create a repo for this printer");
      } else {
        resetWorkspace();
        setSyncTokens([]);
        setRepoStatus("Create a cloud repo when ready");
      }
    }

    setPrinterStatus(deletedPrinter ? `Deleted ${deletedPrinter.name}` : "Printer deleted");
    void deletePrinterFromCloud(id);
  }

  return {
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
  };
}
