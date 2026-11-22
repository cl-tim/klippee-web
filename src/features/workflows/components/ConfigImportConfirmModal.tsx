import { useWorkspaceContext } from "../../../app/contexts/useWorkspaceContext";
import { Button, Text } from "@mantine/core";
import { ModalShell } from "../../../components/ModalShell";

export function ConfigImportConfirmModal() {
  const { pendingConfigImport, cancelConfigImportReplacement, confirmConfigImportReplacement } = useWorkspaceContext();

  if (!pendingConfigImport) {
    return null;
  }

  return (
    <ModalShell
      closeLabel="Cancel import"
      onClose={cancelConfigImportReplacement}
      open
      sizeClass="confirm-modal"
      title="Replace existing files?"
    >
        <Text role="note">{pendingConfigImport.conflicts.length} file{pendingConfigImport.conflicts.length === 1 ? "" : "s"} already exist in this workspace.</Text>
        <div className="conflict-list">
          {pendingConfigImport.conflicts.map((path) => (
            <Text component="span" key={path} style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>{path}</Text>
          ))}
        </div>
        <div className="modal-actions">
          <Button className="inline-action" onClick={cancelConfigImportReplacement} variant="subtle">
            Cancel
          </Button>
          <Button className="primary-action" onClick={confirmConfigImportReplacement}>
            Replace and import
          </Button>
        </div>
    </ModalShell>
  );
}
