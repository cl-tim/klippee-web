import type { WorkspaceTreeTarget } from "./WorkspaceTreeItem";
import { Button, TextInput } from "@mantine/core";
import { HelpRow } from "../../../components/FieldHelp";

export type PendingWorkspaceMove = WorkspaceTreeTarget & {
  destinationPath: string;
  includeCount: number;
};

/**
 * Inline move/rename panel for a workspace file or folder. State (path,
 * validation error, pending include-updating move) stays in the file browser;
 * this component owns only the presentation.
 */
export function RenameMovePanel({
  onCancel,
  onConfirmMove,
  onPathChange,
  onSubmit,
  pendingMove,
  renameError,
  renamePath,
  target,
}: {
  onCancel: () => void;
  onConfirmMove: (move: PendingWorkspaceMove) => void;
  onPathChange: (path: string) => void;
  onSubmit: () => void;
  pendingMove: PendingWorkspaceMove | null;
  renameError: string;
  renamePath: string;
  target: WorkspaceTreeTarget;
}) {
  return (
    <div className="workspace-operation-panel">
      <HelpRow label="Move or rename" help="Enter a path relative to the workspace root.">
        <strong>{target.kind === "folder" ? "Move or rename folder" : "Move or rename file"}</strong>
      </HelpRow>
      <div className="file-browser-create">
        <TextInput
          aria-label={`New path for ${target.path}`}
          autoFocus
          style={{ flex: 1, minWidth: 0 }}
          onChange={(event) => onPathChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
            if (event.key === "Escape") {
              onCancel();
            }
          }}
          value={renamePath}
        />
        <Button className="inline-action" onClick={onSubmit}>Continue</Button>
        <Button className="inline-action" onClick={onCancel} variant="subtle">Cancel</Button>
      </div>
      {renameError ? <p className="workspace-operation-error" role="alert">{renameError}</p> : null}
      {pendingMove ? (
        <div className="workspace-operation-warning" role="alert">
          <p>
            {pendingMove.includeCount} <code>[include ...]</code> reference
            {pendingMove.includeCount === 1 ? "" : "s"} will be updated with this move.
          </p>
          <Button className="inline-action" onClick={() => onConfirmMove(pendingMove)}>
            Move and update references
          </Button>
        </div>
      ) : null}
    </div>
  );
}
