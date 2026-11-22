import { useId, useState } from "react";
import { Button, Modal } from "@mantine/core";
import { useRepositoryContext } from "../../../app/contexts/useRepositoryContext";
import type { WorkspaceConflictReview as Review } from "../../../app/hooks/useWorkspaceConflict";
import type { WorkspaceFileChoice } from "../../../app/workspaceConflict";

function FileReview({ review }: { review: Review }) {
  const { workspaceConflictBusy: busy, workspaceConflictStatus: status,
    reviewWorkspaceConflict, resolveWorkspaceConflict, closeWorkspaceConflictReview } = useRepositoryContext();
  const [choices, setChoices] = useState<Record<string, WorkspaceFileChoice>>({});
  const groupId = useId();
  return <>
    <p>Review the baseline, your local edits and the current cloud files. Independent changes are suggested automatically; conflicting edits need your choice.</p>
    <p>Confirming stages the reviewed files for your connected printer to apply. Closing this review preserves your local edits and keeps sync paused.</p>
    <p role="status">{status}</p>
    {review.files.map((file, index) => <fieldset className="workspace-conflict-file" disabled={busy} key={file.path}>
      <legend>{file.path}</legend>
      <p>{file.suggested ? "Suggested result: " + file.suggested : "Choose which version to keep."}</p>
      <details open={!file.suggested}>
        <summary>Compare file contents</summary>
        <div className="workspace-conflict-grid">
          {([['Baseline', file.baseline], ['Local', file.local], ['Cloud', file.cloud]] as const).map(([label, value]) => <section key={label}>
            <h3>{label}</h3>
            <pre tabIndex={0} aria-label={`${label} contents of ${file.path}`}>{value === undefined ? "Baseline unavailable on this device. Choose explicitly between local and cloud."
              : value === null ? "File absent (not present or deleted)." : value.content || "(Empty file)"}</pre>
          </section>)}
        </div>
      </details>
      <div className="workspace-conflict-choices">
        {(["local", "cloud"] as const).map(side => <label key={side}>
          <input type="radio" name={`${groupId}-${index}`} aria-label={`Use ${side} for ${file.path}`}
            checked={(choices[file.path] ?? file.suggested) === side}
            onChange={() => setChoices(current => ({ ...current, [file.path]: side }))} />
          Use {side}{file[side] === null ? " deletion / absence" : " file"}
        </label>)}
      </div>
    </fieldset>)}
    <div className="workspace-conflict-actions">
      <Button variant="default" disabled={busy} onClick={closeWorkspaceConflictReview}>Keep editing locally</Button>
      <Button variant="default" disabled={busy} onClick={() => void reviewWorkspaceConflict()}>Refresh review</Button>
      <Button disabled={busy} onClick={() => void resolveWorkspaceConflict(choices)}>{busy ? "Checking…" : "Stage reviewed files"}</Button>
    </div>
  </>;
}

export function WorkspaceConflictReview() {
  const { workspaceConflictReview: review, workspaceConflictBusy: busy, closeWorkspaceConflictReview } = useRepositoryContext();
  return <Modal opened={Boolean(review)} onClose={closeWorkspaceConflictReview} title="Review configuration conflict" size="xl"
    closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}>
    {review && <FileReview key={review.id} review={review} />}
  </Modal>;
}
