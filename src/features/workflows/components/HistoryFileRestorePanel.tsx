import { Button } from "@mantine/core";
import { useMemo } from "react";
import { buildFileDiff } from "../../../diff";
import { useRepositoryContext } from "../../../app/contexts/useRepositoryContext";

export function HistoryFileRestorePanel() {
  const { historyFileRestoreReview: review, historyFileRestoreBusy: busy, historyFileRestoreStatus: status,
    confirmHistoryFileRestore, cancelHistoryFileRestore, reviewHistoryFileRestore } = useRepositoryContext();
  const preview = useMemo(() => {
    if (!review) return null;
    const before = review.before?.content ?? "", after = review.after.content;
    // The existing line diff uses a quadratic matrix. Large configurations
    // remain reviewable as before/after text without allocating that matrix.
    if (before.split("\n").length * after.split("\n").length > 1_000_000) return "large";
    return buildFileDiff(review.before ? [review.before] : [], [review.after])[0] ?? null;
  }, [review]);
  return <section aria-label="Single-file restore" className="history-file-restore">
    {status && <p role="status">{status}</p>}
    {review && <>
      <h3>Restore {review.after.path} from recovery point {review.sourceVersionNumber}?</h3>
      <p>This replaces only this file in the pending draft and keeps your other draft files. Review the change, then confirm. The printer's applied state and saved history stay unchanged; apply the draft on the printer when ready.</p>
      {preview === "large" ? <div className="history-file-restore-sides">
        <section><h4>Current draft</h4><pre tabIndex={0}>{review.before?.content ?? "File not present in current draft."}</pre></section>
        <section><h4>Recovery file</h4><pre tabIndex={0}>{review.after.content || "(Empty file)"}</pre></section>
      </div> : preview ? <>
        <p>{preview.status === "added" ? "This file will be added to the draft. " : ""}+{preview.addedLines} / −{preview.removedLines} lines. − = current draft; + = recovery file.</p>
        <pre className="version-diff-preview" tabIndex={0} aria-label={`Restore diff for ${review.after.path}`}>
          {preview.lines.map((line, index) => <code className={`is-${line.kind}`} key={index}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "} {line.text}</code>)}
        </pre>
      </> : <p>The file already has the same contents. Confirming keeps those contents and restores its saved file metadata.</p>}
      <div className="history-file-restore-actions">
        <Button variant="default" disabled={busy} onClick={() => cancelHistoryFileRestore()}>Cancel file restore</Button>
        <Button variant="default" disabled={busy} onClick={() => void reviewHistoryFileRestore(review.sourceVersionNumber, review.after.path)}>Refresh file review</Button>
        <Button disabled={busy} onClick={() => void confirmHistoryFileRestore()}>{busy ? "Checking…" : "Restore file to draft"}</Button>
      </div>
    </>}
  </section>;
}
