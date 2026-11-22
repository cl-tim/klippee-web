import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { cloudFetch } from "../cloudFetch";
import { powershellQuote, shellCommandQuote } from "../helpers";
import {
  parseRepositoryCreateResponse,
  parseSyncTokenCreateResponse,
  parseSyncTokensResponse,
} from "../responseGuards";
import type { AuthUser, PrinterRecord, RepositorySyncStatus, SyncTokenRecord } from "../types";
import { repositoryFilesRevision } from "../../repositoryRevision";
import type { ConfigFile, HistoryVersion, PrinterState } from "../../types";
import { useAccountStorage } from "../contexts/useAccountStorage";

type StageRepositoryResponse = {
  code?: string;
  desired?: {
    createdAt: string;
    revision: string;
  } | null;
};

type RepositorySyncOptions = {
  activeRepositoryId: string | null;
  authUser: AuthUser | null;
  bindRepositoryToSelectedPrinter: (nextRepositoryId: string | null) => void;
  latestVersion: HistoryVersion | null;
  printer: PrinterState;
  selectedPrinter: PrinterRecord | null;
  setPrinter: Dispatch<SetStateAction<PrinterState>>;
  setPrinters: Dispatch<SetStateAction<PrinterRecord[]>>;
  setRepoStatus: (status: string) => void;
};

export function useRepositorySync({
  activeRepositoryId,
  authUser,
  bindRepositoryToSelectedPrinter,
  latestVersion,
  printer,
  selectedPrinter,
  setPrinter,
  setPrinters,
  setRepoStatus,
}: RepositorySyncOptions) {
  const { saveStored } = useAccountStorage();
  const [syncStatus, setSyncStatus] = useState("Connect a cloud repo to check sync");
  // True after a draft stage was rejected with a 409: the desired
  // configuration changed under this editor. While set, auto-staging is
  // suppressed so the client does not retry against a stale baseline; a
  // repository reload clears it.
  const [syncConflictScope, setSyncConflictScope] = useState<string | null>(null);
  const [syncCheckedAt, setSyncCheckedAt] = useState<string | null>(null);
  const [pendingConfiguration, setPendingConfiguration] = useState<RepositorySyncStatus["pendingConfiguration"]>(null);
  const [syncToken, setSyncToken] = useState("");
  const [syncTokenClientMode, setSyncTokenClientMode] = useState<"desktop" | "printer" | null>(null);
  const [syncTokenId, setSyncTokenId] = useState("");
  const [syncTokenRepositoryId, setSyncTokenRepositoryId] = useState<string | null>(null);
  const [syncTokens, setSyncTokens] = useState<SyncTokenRecord[]>([]);
  const workspaceBaselinesRef = useRef(new Map<string, string | null>());
  const scope = `${authUser?.id}:${selectedPrinter?.id}:${activeRepositoryId}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const stageSequence = useRef(0);
  const syncConflict = syncConflictScope === scope;

  function workspaceBaselineKey(targetRepositoryId: string) {
    return `${selectedPrinter?.id ?? "unscoped"}:${targetRepositoryId}`;
  }

  function rememberWorkspaceBaseline(targetRepositoryId: string, revision: string | null, files: ConfigFile[]) {
    workspaceBaselinesRef.current.set(workspaceBaselineKey(targetRepositoryId), revision);
    const printerId = selectedPrinter?.id;
    if (!printerId) {
      return;
    }
    setPrinters((current) => {
      let changed = false;
      const next = current.map((candidate) => {
        if (
          candidate.id !== printerId
          || candidate.repositoryId !== targetRepositoryId
          || (candidate.workspaceBaseRevision === revision && candidate.workspaceBaseFiles !== undefined)
        ) {
          return candidate;
        }
        changed = true;
        return { ...candidate, workspaceBaseRevision: revision, workspaceBaseFiles: files };
      });
      if (changed) {
        saveStored("printers", next);
      }
      return changed ? next : current;
    });
  }

  useEffect(() => {
    if (!activeRepositoryId || selectedPrinter?.repositoryId !== activeRepositoryId) {
      return;
    }
    const key = `${selectedPrinter.id}:${activeRepositoryId}`;
    if (selectedPrinter.workspaceBaseRevision === undefined) {
      workspaceBaselinesRef.current.delete(key);
    } else {
      workspaceBaselinesRef.current.set(key, selectedPrinter.workspaceBaseRevision);
    }
  }, [activeRepositoryId, selectedPrinter?.id, selectedPrinter?.repositoryId, selectedPrinter?.workspaceBaseRevision]);

  const syncPullUrl = activeRepositoryId ? `${window.location.origin}/api/sync/repos/${activeRepositoryId}/pull` : "";
  function buildPrinterInstallCommand(configDirectory = "", captureCurrent = false) {
    if (
      !activeRepositoryId
      || activeRepositoryId !== syncTokenRepositoryId
      || !syncToken
      || syncTokenClientMode !== "printer"
    ) {
      return "";
    }
    return [
      `KLIPPEE_BASE_URL=${shellCommandQuote(window.location.origin)}`,
      `KLIPPEE_REPOSITORY_ID=${shellCommandQuote(activeRepositoryId)}`,
      `KLIPPEE_TOKEN=${shellCommandQuote(syncToken)}`,
      configDirectory.trim() ? `KLIPPEE_CONFIG_DIR=${shellCommandQuote(configDirectory.trim())}` : "",
      "hlab klippee init --printer",
      captureCurrent ? "--capture-current" : "",
    ].filter(Boolean).join(" ");
  }
  function buildDesktopInstallCommand(platform: "windows" | "unix" = "windows") {
    if (
      !activeRepositoryId
      || activeRepositoryId !== syncTokenRepositoryId
      || !syncToken
      || syncTokenClientMode !== "desktop"
    ) {
      return "";
    }
    if (platform === "windows") {
      return [
        `$env:KLIPPEE_BASE_URL=${powershellQuote(window.location.origin)}`,
        `$env:KLIPPEE_REPOSITORY_ID=${powershellQuote(activeRepositoryId)}`,
        `$env:KLIPPEE_TOKEN=${powershellQuote(syncToken)}`,
        "try { hlab klippee init --desktop --apply-current; if ($LASTEXITCODE -ne 0) { throw 'hlab setup failed' } } finally { Remove-Item Env:KLIPPEE_TOKEN -ErrorAction SilentlyContinue }",
      ].filter(Boolean).join("; ");
    }
    return [
      `KLIPPEE_BASE_URL=${shellCommandQuote(window.location.origin)}`,
      `KLIPPEE_REPOSITORY_ID=${shellCommandQuote(activeRepositoryId)}`,
      `KLIPPEE_TOKEN=${shellCommandQuote(syncToken)}`,
      "hlab klippee init --desktop --apply-current",
    ].filter(Boolean).join(" ");
  }
  const clientInstallCommand = buildPrinterInstallCommand();

  async function createCloudRepository() {
    if (!authUser) {
      setRepoStatus("Sign in first");
      return;
    }

    if (!selectedPrinter) {
      setRepoStatus("Select a printer first");
      return;
    }

    if (!latestVersion) {
      setRepoStatus("Import config files first");
      return;
    }

    const result = await cloudFetch("/api/repos", {
      method: "POST",
      json: {
        files: latestVersion.files,
        message: latestVersion.message,
        name: selectedPrinter.name,
        title: selectedPrinter.name,
      },
      onStatus: setRepoStatus,
      validate: parseRepositoryCreateResponse,
      messages: {
        pending: "Creating repo",
        fail: "Repo create failed",
        error: "Repo create unavailable",
      },
    });
    if (!result.ok || !result.data) {
      return;
    }
    bindRepositoryToSelectedPrinter(result.data.repository.id);
    rememberWorkspaceBaseline(
      result.data.repository.id,
      await repositoryFilesRevision(latestVersion.files),
      latestVersion.files,
    );
    setRepoStatus(`Repo ${result.data.repository.name} created`);
    void loadSyncTokens(result.data.repository.id);
  }

  async function createSyncTokenForRepository(targetRepositoryId: string, clientMode: "desktop" | "printer") {
    if (!targetRepositoryId) {
      setSyncStatus("Create a cloud repo first");
      return false;
    }

    const result = await cloudFetch(`/api/repos/${targetRepositoryId}/sync-tokens`, {
      method: "POST",
      json: {
        clientMode,
        name: `${printer.name} ${clientMode} sync token`,
        printerId: selectedPrinter?.id ?? null,
        scopes: ["repo:read", "repo:write"],
      },
      onStatus: setSyncStatus,
      validate: parseSyncTokenCreateResponse,
      messages: {
        pending: `Creating ${clientMode} token`,
        fail: "Token create failed",
        error: "Token create unavailable",
      },
    });
    if (!result.ok || !result.data) {
      return false;
    }
    setSyncToken(result.data.token);
    setSyncTokenClientMode(clientMode);
    setSyncTokenId(result.data.tokenRecord?.id ?? "");
    setSyncTokenRepositoryId(targetRepositoryId);
    setSyncStatus(`${clientMode === "desktop" ? "Desktop" : "Printer"} connection command ready`);
    void loadSyncTokens(targetRepositoryId);
    return true;
  }

  async function createPrinterSyncToken() {
    if (!activeRepositoryId) {
      setSyncStatus("Create a cloud repo first");
      return;
    }
    await createSyncTokenForRepository(activeRepositoryId, "printer");
  }

  async function createDesktopSyncToken() {
    if (!activeRepositoryId) {
      setSyncStatus("Create a cloud repo first");
      return;
    }
    await createSyncTokenForRepository(activeRepositoryId, "desktop");
  }

  async function linkCurrentPrinter() {
    if (!authUser || !selectedPrinter) {
      setSyncStatus("Select a signed-in printer first");
      return;
    }

    if (activeRepositoryId) {
      await createSyncTokenForRepository(activeRepositoryId, "printer");
      return;
    }

    const result = await cloudFetch("/api/repos", {
      method: "POST",
      json: {
        empty: true,
        name: `${selectedPrinter.name}-${selectedPrinter.id.slice(0, 8)}`,
        title: selectedPrinter.name,
      },
      onStatus: setSyncStatus,
      validate: parseRepositoryCreateResponse,
      messages: {
        pending: "Creating private printer link",
        fail: "Printer link failed",
        error: "Printer link unavailable",
      },
    });
    if (!result.ok || !result.data) {
      return;
    }

    const targetRepositoryId = result.data.repository.id;
    bindRepositoryToSelectedPrinter(targetRepositoryId);
    rememberWorkspaceBaseline(targetRepositoryId, null, []);
    const tokenCreated = await createSyncTokenForRepository(targetRepositoryId, "printer");
    setRepoStatus(
      tokenCreated
        ? `Linked ${selectedPrinter.name}; import its current config next`
        : `Linked ${selectedPrinter.name}; create an import token next`,
    );
  }

  async function loadSyncTokens(targetRepositoryId = activeRepositoryId) {
    if (!targetRepositoryId) {
      setSyncTokens([]);
      return;
    }

    const result = await cloudFetch(
      `/api/repos/${targetRepositoryId}/sync-tokens`,
      { validate: parseSyncTokensResponse },
    );
    if (result.ok && result.data) {
      setSyncTokens(result.data.tokens);
    }
  }

  async function revokeSyncToken(tokenId: string) {
    if (!activeRepositoryId) {
      return;
    }

    const tokenRecord = syncTokens.find((token) => token.id === tokenId);
    const revokesGeneratedCredential = syncTokenRepositoryId === activeRepositoryId
      && (
        syncTokenId === tokenId
        || Boolean(tokenRecord && syncToken && tokenRecord.token_prefix === syncToken.slice(0, tokenRecord.token_prefix.length))
      );
    const result = await cloudFetch(`/api/repos/${activeRepositoryId}/sync-tokens/${tokenId}`, {
      method: "DELETE",
      onStatus: setSyncStatus,
      messages: {
        pending: "Revoking token",
        fail: "Token revoke failed",
        error: "Token revoke unavailable",
      },
    });
    if (!result.ok) {
      return;
    }

    setSyncTokens((current) => current.filter((token) => token.id !== tokenId));
    if (revokesGeneratedCredential) {
      setSyncToken("");
      setSyncTokenClientMode(null);
      setSyncTokenId("");
      setSyncTokenRepositoryId(null);
    }
    setSyncStatus("Token revoked");
  }

  async function refreshSyncStatus() {
    if (!activeRepositoryId) {
      setSyncStatus("Connect a cloud repo to check sync");
      setSyncCheckedAt(null);
      setPendingConfiguration(null);
      return;
    }

    const result = await cloudFetch<RepositorySyncStatus>(`/api/repos/${activeRepositoryId}/sync-status`);
    if (!result.ok || !result.data) {
      setSyncStatus("Sync status unavailable");
      setSyncCheckedAt(new Date().toISOString());
      setPendingConfiguration(null);
      return;
    }

    const data = result.data;
    if (data.printer) {
      const cloudPrinter = data.printer;
      setPrinter((current) => {
        const next = {
          ...current,
          appliedAt: cloudPrinter.appliedAt,
          appliedVersionId: cloudPrinter.appliedVersionId,
          latestVersionId: cloudPrinter.latestVersionId,
          name: cloudPrinter.name,
        };
        saveStored("printer", next);
        return next;
      });
      setPrinters((current) => {
        const next = current.map((candidate) => (
          candidate.id === cloudPrinter.id ? { ...candidate, ...cloudPrinter } : candidate
        ));
        saveStored("printers", next);
        return next;
      });
    }
    setPendingConfiguration(data.pendingConfiguration ?? null);
    setSyncStatus(
      data.pendingConfiguration
        ? `Draft saved for printer apply (${data.pendingConfiguration.fileCount} configuration ${data.pendingConfiguration.fileCount === 1 ? "file" : "files"})`
        : !data.latestVersion
        ? "No desired configuration yet"
        : data.updateAvailable
          ? "The desired configuration has not been applied to this printer"
          : "Printer matches the desired configuration",
    );
    setSyncCheckedAt(new Date().toISOString());
    void loadSyncTokens(activeRepositoryId);
  }

  function clearSyncConflict() {
    setSyncConflictScope(null);
  }
  function pauseSyncForReview() {
    // Invalidate acknowledgements still in flight when the user opens review.
    // They must not resume staging or rebase edits behind the review dialog.
    stageSequence.current += 1;
    setSyncConflictScope(scopeRef.current);
  }
  function pauseRepositoryStaging() {
    stageSequence.current += 1;
  }

  // Stage the current desired configuration without creating a version. A
  // physical printer captures it as a version only when it applies (server-side).
  async function stageRepositoryConfig(targetRepositoryId: string, files: ConfigFile[], review?: { baseRevision: string | null }) {
    const requestScope = scopeRef.current;
    const requestSequence = ++stageSequence.current;
    const key = workspaceBaselineKey(targetRepositoryId);
    let baseRevision: string | null;
    if (review) {
      baseRevision = review.baseRevision;
    } else if (workspaceBaselinesRef.current.has(key)) {
      baseRevision = workspaceBaselinesRef.current.get(key) ?? null;
    } else if (
      selectedPrinter?.repositoryId === targetRepositoryId
      && selectedPrinter.workspaceBaseRevision !== undefined
    ) {
      baseRevision = selectedPrinter.workspaceBaseRevision;
    } else {
      baseRevision = latestVersion ? await repositoryFilesRevision(latestVersion.files) : null;
    }

    if (scopeRef.current !== requestScope || stageSequence.current !== requestSequence) return false;
    const result = await cloudFetch<StageRepositoryResponse>(`/api/repos/${targetRepositoryId}/pending`, {
      method: "PUT",
      json: { baseRevision, files },
    });
    if (scopeRef.current !== requestScope || stageSequence.current !== requestSequence) return false;
    if (!result.ok) {
      if (result.status === 409 && result.data?.code === "desired_configuration_conflict") {
        const message = "Draft conflict: another editor changed the desired configuration; reload before retrying";
        setSyncConflictScope(requestScope);
        setRepoStatus(message);
        setSyncStatus(message);
      } else {
        if (result.status === 409) {
          setSyncConflictScope(requestScope);
        }
        setRepoStatus(
          result.status === 409
            ? "Draft not saved: reload the repository to establish a current baseline"
            : "Draft could not be saved to the printer repository",
        );
      }
      return false;
    }

    if (!result.data || result.data.desired === undefined
      || (files.length > 0 && (!result.data.desired || typeof result.data.desired.revision !== "string"))) {
      setRepoStatus("Draft save returned an invalid response");
      return false;
    }
    const nextRevision = result.data.desired?.revision ?? null;
    if (!review) {
      setSyncConflictScope(null);
      rememberWorkspaceBaseline(targetRepositoryId, nextRevision, files);
    }
    setPendingConfiguration(result.data.desired
      ? {
          fileCount: files.length,
          revision: nextRevision ?? "",
          updatedAt: result.data.desired.createdAt,
        }
      : null);
    setRepoStatus(files.length > 0 ? "Draft saved for printer apply" : "Printer draft cleared");
    return true;
  }

  useEffect(() => {
    if (!activeRepositoryId) {
      return undefined;
    }

    const initialTimer = window.setTimeout(() => {
      void refreshSyncStatus();
    }, 0);
    const timer = window.setInterval(() => {
      void refreshSyncStatus();
    }, 30000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
    // Poll only follows the active repo id; refreshSyncStatus reads latest component state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepositoryId]);

  return {
    createCloudRepository,
    createDesktopSyncToken,
    createPrinterSyncToken,
    buildDesktopInstallCommand,
    buildPrinterInstallCommand,
    linkCurrentPrinter,
    loadSyncTokens,
    stageRepositoryConfig,
    refreshSyncStatus,
    revokeSyncToken,
    setSyncStatus,
    setSyncTokens,
    clientInstallCommand,
    clearSyncConflict,
    pauseSyncForReview,
    pauseRepositoryStaging,
    rememberWorkspaceBaseline,
    pendingConfiguration,
    syncCheckedAt,
    syncConflict,
    syncPullUrl,
    syncStatus,
    syncToken: syncTokenRepositoryId === activeRepositoryId ? syncToken : "",
    syncTokens,
  };
}
