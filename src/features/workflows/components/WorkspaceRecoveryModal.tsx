import { Trash2 } from "lucide-react";
import { ActionIcon, Badge, Button, NativeSelect, UnstyledButton } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { usePrinterContext } from "../../../app/contexts/usePrinterContext";
import { useRepositoryContext } from "../../../app/contexts/useRepositoryContext";
import { formatDate } from "../../../app/format";
import { ModalShell } from "../../../components/ModalShell";
import { buildFileDiff } from "../../../diff";
import { HistoryFileRestorePanel } from "./HistoryFileRestorePanel";

export function WorkspaceRecoveryModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const { selectedPrinter } = usePrinterContext();
  const { deleteVersion, history, pendingConfiguration, printer, historyFileRestoreBusy, historyFileRestoreReview,
    reviewHistoryFileRestore, cancelHistoryFileRestore } = useRepositoryContext();
  const [pendingDeleteVersion, setPendingDeleteVersion] = useState<number | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [restoreFilePath, setRestoreFilePath] = useState("");
  useEffect(() => () => cancelHistoryFileRestore(true), [cancelHistoryFileRestore]);
  const recentVersions = history.slice().reverse();
  const duplicateVersionIds = useMemo(() => findDuplicateVersionIds(history), [history]);
  const selectedVersion = history.find((version) => version.id === selectedVersionId) ?? null;
  const selectedVersionDiff = useMemo(() => {
    if (!selectedVersion) return [];
    const previousVersion = history.find((version) => version.id === selectedVersion.previousId);
    return buildFileDiff(previousVersion?.files ?? [], selectedVersion.files);
  }, [history, selectedVersion]);
  const currentLatestVersionId = selectedPrinter?.latestVersionId ?? printer.latestVersionId;
  const currentAppliedVersionId = selectedPrinter?.appliedVersionId ?? printer.appliedVersionId;
  const pendingDraft = Boolean(pendingConfiguration);

  return (
    <ModalShell
      closeLabel="Close configuration recovery"
      help="Review immutable saved configurations and choose what the printer should apply next."
      onClose={() => { if (!historyFileRestoreBusy) { cancelHistoryFileRestore(); onClose(); } }}
      busy={historyFileRestoreBusy}
      open={open}
      sizeClass="workspace-recovery-modal"
      title="Configuration recovery"
    >
        {pendingDraft && recentVersions.length > 0 ? (
          <div className="workspace-operation-panel" role="status">
            <strong>A draft is currently desired</strong>
            <span>
              Select any recovery point below and run its printer command to replace the draft. Choosing the latest
              saved point cancels the draft without changing immutable history.
            </span>
          </div>
        ) : null}

        {recentVersions.length === 0 ? (
          <div className="empty-state">Apply or capture a printer configuration to create a recovery point.</div>
        ) : (
          <div className="workspace-version-grid">
            {recentVersions.map((version) => {
              const duplicateOf = duplicateVersionIds.get(version.id);
              const confirmingDelete = pendingDeleteVersion === version.id;
              const selected = selectedVersionId === version.id;
              const remainingVersions = history.filter((candidate) => candidate.id !== version.id);
              const nextLatestVersion = remainingVersions[remainingVersions.length - 1] ?? null;
              const protectedAppliedVersion = version.id === currentAppliedVersionId;
              return (
                <div className={`version-rail-row${selected ? " is-selected" : ""}${confirmingDelete ? " is-confirming-delete" : ""}`} key={version.id}>
                  <UnstyledButton
                    aria-expanded={selected}
                    disabled={historyFileRestoreBusy}
                    className="version-row-select"
                    onClick={() => { cancelHistoryFileRestore(); setRestoreFilePath(""); setSelectedVersionId(selected ? null : version.id); }}
                    style={{
                      backgroundColor: "transparent",
                      border: 0,
                      color: "inherit",
                      cursor: "pointer",
                      display: "flex",
                      flex: 1,
                      flexDirection: "column",
                      gap: 2,
                      minWidth: 0,
                      padding: 0,
                      textAlign: "left",
                    }}
                  >
                    <div className="version-title-row">
                      <strong>Recovery point {version.id}</strong>
                      {version.id === currentLatestVersionId ? <Badge variant="light">{pendingDraft ? "Latest saved" : "Desired"}</Badge> : null}
                      {version.id === currentAppliedVersionId ? <Badge variant="light">Applied</Badge> : null}
                      {duplicateOf ? <Badge className="is-duplicate" variant="outline">Duplicate of {duplicateOf}</Badge> : null}
                    </div>
                    <span>{version.message}</span>
                    <small>{formatDate(version.createdAt)} · {version.source}</small>
                  </UnstyledButton>
                  {confirmingDelete ? (
                    <div className="version-delete-confirmation">
                      <div className="version-delete-copy">
                        <strong>Delete recovery point {version.id}?</strong>
                        <span>This permanently removes this saved recovery option.</span>
                        {version.id === currentLatestVersionId && nextLatestVersion && !pendingDraft ? (
                          <span>Recovery point {nextLatestVersion.id} will become the desired configuration.</span>
                        ) : null}
                        {version.id === currentLatestVersionId && nextLatestVersion && pendingDraft ? (
                          <span>The draft remains desired; recovery point {nextLatestVersion.id} becomes the latest saved fallback.</span>
                        ) : null}
                      </div>
                      <div className="version-delete-actions">
                        <Button className="inline-action" onClick={() => setPendingDeleteVersion(null)} variant="subtle">Keep recovery point</Button>
                        <Button className="danger-action" color="red" disabled={historyFileRestoreBusy || Boolean(historyFileRestoreReview)} onClick={() => void deleteVersion(version).then((deleted) => deleted && setPendingDeleteVersion(null))} variant="outline">Delete recovery point {version.id}</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="version-row-actions">
                      <ActionIcon
                        aria-label={`Delete recovery point ${version.id}`}
                        className="danger-icon"
                        color="red"
                        disabled={history.length <= 1 || protectedAppliedVersion || historyFileRestoreBusy || Boolean(historyFileRestoreReview)}
                        onClick={() => setPendingDeleteVersion(version.id)}
                        size={44}
                        title={protectedAppliedVersion
                          ? "The last confirmed printer configuration cannot be deleted"
                          : history.length <= 1
                            ? "At least one recovery point must remain"
                            : "Delete recovery point"}
                        variant="subtle"
                      ><Trash2 size={15} /></ActionIcon>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {selectedVersion ? (
          <section aria-live="polite" className="version-changelog">
            <div className="history-file-restore-picker">
              <NativeSelect label="File to restore" value={restoreFilePath} disabled={historyFileRestoreBusy}
                onChange={event => { cancelHistoryFileRestore(); setRestoreFilePath(event.currentTarget.value); }}
                data={[{ value: "", label: "Choose a file from this recovery point" }, ...selectedVersion.files.map(file => ({ value: file.path, label: file.path }))]} />
              <Button disabled={!restoreFilePath || !selectedPrinter?.repositoryId || historyFileRestoreBusy}
                onClick={() => void reviewHistoryFileRestore(selectedVersion.id, restoreFilePath)}>Review file restore</Button>
              {!selectedPrinter?.repositoryId && <p>Connect this printer to a cloud repository to restore a file into its pending draft.</p>}
            </div>
            <HistoryFileRestorePanel />
            <header>
              <div>
                <strong>Changes in recovery point {selectedVersion.id}</strong>
                <span>{selectedVersion.message}</span>
              </div>
              {pendingDraft || selectedVersion.id !== currentLatestVersionId ? (
                <code>hlab klippee recover cloud:{selectedVersion.id}</code>
              ) : <Badge className="version-current-note" variant="light">Desired configuration</Badge>}
            </header>
            {selectedVersionDiff.length ? (
              <div className="version-changelog-files">
                {selectedVersionDiff.map((file) => {
                  const changedLines = file.lines.filter((line) => line.kind !== "same");
                  return (
                    <details key={file.path}>
                      <summary>
                        <span><strong>{file.path}</strong><small>{file.status}</small></span>
                        <span className="version-diff-counts"><b>+{file.addedLines}</b><i>-{file.removedLines}</i></span>
                      </summary>
                      <pre className="version-diff-preview">
                        {changedLines.map((line, index) => (
                          <code className={`is-${line.kind}`} key={`${line.kind}-${index}`}>{line.kind === "added" ? "+" : "-"} {line.text}</code>
                        ))}
                      </pre>
                    </details>
                  );
                })}
              </div>
            ) : <div className="empty-state">This recovery point has the same files as the previous point.</div>}
          </section>
        ) : null}
    </ModalShell>
  );
}

function findDuplicateVersionIds(history: Array<{ files: Array<{ content: string; path: string }>; id: number }>) {
  const firstVersionBySignature = new Map<string, number>();
  const duplicateVersionIds = new Map<number, number>();
  for (const version of [...history].sort((a, b) => a.id - b.id)) {
    const signature = JSON.stringify([...version.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => [file.path, file.content]));
    const originalVersionId = firstVersionBySignature.get(signature);
    if (originalVersionId !== undefined) {
      duplicateVersionIds.set(version.id, originalVersionId);
    } else {
      firstVersionBySignature.set(signature, version.id);
    }
  }
  return duplicateVersionIds;
}
