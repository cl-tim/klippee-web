import { useEffect, useRef } from "react";
import { cloudFetch } from "../cloudFetch";
import { formatDate } from "../format";
import type { AuthUser, CloudState, PrinterRecord } from "../types";
import type { HistoryVersion, PrinterState } from "../../types";

export const cloudAppStateMaxBytes = 512_000;

type CloudAppStateOptions = {
  authUser: AuthUser | null;
  cloudStateReady: boolean;
  currentWorkspaceContent: string;
  history: HistoryVersion[];
  printer: PrinterState;
  printers: PrinterRecord[];
  repositoryId: string | null;
  selectedFilePath: string;
  selectedCompanionAssetId: string;
  selectedPackageId: string;
  selectedPrinterId: string;
  setCloudStatus: (status: string) => void;
  setDraftSavedAt: (value: string | null) => void;
  workspaceChanged: boolean;
  workspaceBaseRevision?: string | null;
  workspaceDrafts: Record<string, string>;
  workspaceFilePath: string;
  flushLocalState?: () => Promise<void>;
  initialCloudRevision?: string | null;
  onCloudRevision?: (revision: string | null) => void;
};

export type CloudAppStateSnapshot = Pick<
  CloudAppStateOptions,
  | "currentWorkspaceContent"
  | "history"
  | "printer"
  | "printers"
  | "repositoryId"
  | "selectedCompanionAssetId"
  | "selectedFilePath"
  | "selectedPackageId"
  | "selectedPrinterId"
  | "workspaceFilePath"
>;

function compactPrinterState(record: PrinterRecord): PrinterRecord {
  const history = record.history;
  const metadataAndDrafts = { ...record };
  delete metadataAndDrafts.history;
  delete metadataAndDrafts.variableValues;
  delete metadataAndDrafts.workspaceBaseFiles;
  if (record.repositoryId || !history?.length) {
    return metadataAndDrafts;
  }
  return { ...metadataAndDrafts, history: history.slice(-1) };
}

export function buildCloudAppState({
  currentWorkspaceContent,
  history,
  printer,
  printers,
  repositoryId,
  selectedCompanionAssetId,
  selectedFilePath,
  selectedPackageId,
  selectedPrinterId,
  workspaceFilePath,
}: CloudAppStateSnapshot): CloudState {
  return {
    // Repository history, private packages, companion assets, and core printer
    // metadata all have dedicated APIs. App-state only needs navigation and
    // client-only workspace data; retaining one local-only version preserves
    // an unbound printer without allowing browser autosave to grow indefinitely.
    history: repositoryId ? [] : history.slice(-1),
    printer,
    printers: printers.map(compactPrinterState),
    repositoryId,
    selectedPrinterId,
    selectedFilePath,
    selectedCompanionAssetId,
    selectedPackageId,
    workspaceContent: currentWorkspaceContent,
    workspaceFilePath,
  };
}

export function cloudAppStatePayloadBytes(state: CloudState): number {
  // Include the longest possible revision so the complete request stays under
  // the server's streamed-body limit, including its concurrency metadata.
  return new TextEncoder().encode(JSON.stringify({ expectedRevision: "0".repeat(64), state })).byteLength;
}

/** Compare JSON state independently of object property insertion order. */
export function cloudAppStatesEqual(first: CloudState, second: CloudState | null): boolean {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
  }
  return JSON.stringify(canonical(JSON.parse(JSON.stringify(first))))
    === JSON.stringify(canonical(JSON.parse(JSON.stringify(second))));
}

export function useCloudAppState({
  authUser,
  cloudStateReady,
  currentWorkspaceContent,
  history,
  printer,
  printers,
  repositoryId,
  selectedFilePath,
  selectedCompanionAssetId,
  selectedPackageId,
  selectedPrinterId,
  setCloudStatus,
  setDraftSavedAt,
  workspaceChanged,
  workspaceBaseRevision,
  workspaceDrafts,
  workspaceFilePath,
  flushLocalState,
  initialCloudRevision,
  onCloudRevision,
}: CloudAppStateOptions) {
  const revisionRef = useRef<string | null>(initialCloudRevision ?? null);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  function setCloudStateRevision(revision: string | null) {
    revisionRef.current = revision;
    onCloudRevision?.(revision);
  }
  function currentCloudState(overrides: Partial<CloudAppStateSnapshot> = {}): CloudState {
    return buildCloudAppState({
      currentWorkspaceContent,
      history,
      printer,
      printers,
      repositoryId,
      selectedPrinterId,
      selectedFilePath,
      selectedCompanionAssetId,
      selectedPackageId,
      workspaceFilePath,
      ...overrides,
    });
  }

  async function saveCloudState(
    mode: "manual" | "autosave" = "manual",
    overrides: Partial<CloudAppStateSnapshot> = {},
  ) {
    if (!authUser) {
      setCloudStatus("Sign in first");
      return false;
    }

    const state = currentCloudState(overrides);
    if (cloudAppStatePayloadBytes(state) > cloudAppStateMaxBytes) {
      setCloudStatus(
        mode === "autosave"
          ? "Draft saved locally; too large for cloud autosave"
          : "Workspace is too large to save to cloud",
      );
      return false;
    }

    // Capture this call's workspace before waiting, but obtain the revision
    // only when its turn starts. A slow older save can never land after a newer
    // save from this tab, and another tab cannot overwrite its baseline.
    const queued = saveQueueRef.current.then(async () => {
      if (!activeRef.current) return false;
      const result = await cloudFetch<{ revision?: unknown }>("/api/app-state", {
        method: "PUT",
        json: { expectedRevision: revisionRef.current, state },
        onStatus: (status) => { if (activeRef.current) setCloudStatus(status); },
        messages: {
          pending: mode === "autosave" ? "Autosaving draft" : "Saving",
          ok: mode === "autosave" ? "Draft autosaved" : "Saved to cloud",
          fail: "Cloud save failed",
          error: "Cloud save unavailable",
        },
      });
      if (result.ok && activeRef.current && typeof result.data?.revision === "string") {
        setCloudStateRevision(result.data.revision);
        try {
          await flushLocalState?.();
        } catch {
          if (activeRef.current) setCloudStatus("Cloud backup saved; saving its revision on this device failed");
        }
      }
      return result.ok;
    });
    saveQueueRef.current = queued.catch(() => undefined);
    return queued;
  }

  useEffect(() => {
    if (!cloudStateReady || !workspaceChanged) {
      return undefined;
    }

    let active = true;
    setDraftSavedAt(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await flushLocalState?.();
          if (!active) return;
          const savedAt = new Date().toISOString();
          setDraftSavedAt(savedAt);
          if (authUser) {
            await saveCloudState("autosave");
          } else {
            setCloudStatus(`Draft saved locally ${formatDate(savedAt)}`);
          }
        } catch {
          if (active) setCloudStatus("Draft remains open; saving on this device failed");
        }
      })();
    }, 1400);

    return () => { active = false; window.clearTimeout(timer); };
    // Idle autosave should react to draft edits, not every function identity change in this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, cloudStateReady, workspaceChanged, workspaceBaseRevision, workspaceDrafts, workspaceFilePath]);

  return { currentCloudState, saveCloudState, setCloudStateRevision };
}
