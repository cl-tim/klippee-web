import { useState } from "react";
import { Button, TextInput } from "@mantine/core";
import type { WorkspaceTreeTarget } from "./WorkspaceTreeItem";

export type PendingWorkspaceDelete = WorkspaceTreeTarget & {
  fileCount: number;
  includeCount: number;
};

/**
 * Type-to-confirm deletion panel for a workspace file or folder. The typed
 * confirmation text is local to the panel; render with `key={target.path}` so
 * it resets when the delete target changes.
 */
export function DeleteConfirmPanel({
  onCancel,
  onConfirm,
  target,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  target: PendingWorkspaceDelete;
}) {
  const [confirmationText, setConfirmationText] = useState("");

  return (
    <div aria-label={`Confirm deletion of ${target.path}`} className="workspace-operation-panel" role="group">
      <strong>Delete {target.path}?</strong>
      <p>
        This removes {target.fileCount} config file{target.fileCount === 1 ? "" : "s"} from the
        current draft. The printer keeps its last confirmed configuration until you explicitly apply this draft,
        at which point it will lose the {target.fileCount === 1 ? " file" : " files"}.
        {target.includeCount > 0
          ? ` ${target.includeCount} include reference${target.includeCount === 1 ? "" : "s"} will become invalid.`
          : ""}
      </p>
      <label>
        Type <code>{target.path}</code> to confirm
        <TextInput
          aria-label={`Type ${target.path} to confirm deletion`}
          autoFocus
          label={`Type ${target.path} to confirm`}
          onChange={(event) => setConfirmationText(event.target.value)}
          value={confirmationText}
        />
      </label>
      <div className="file-delete-confirm-actions">
        <Button
          className="inline-action danger-action"
          color="red"
          disabled={confirmationText !== target.path}
          onClick={onConfirm}
          variant="outline"
        >
          Delete {target.kind}
        </Button>
        <Button className="inline-action" onClick={onCancel} variant="subtle">
          Cancel
        </Button>
      </div>
    </div>
  );
}
