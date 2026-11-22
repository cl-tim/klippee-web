import { PackageOpen, Pencil } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { ActionIcon, Button, TextInput, Title } from "@mantine/core";
import { Card } from "@/components/ui/card";
import { usePackageContext } from "../../../app/contexts/usePackageContext";
import { useRepositoryContext } from "../../../app/contexts/useRepositoryContext";
import { useWorkspaceContext } from "../../../app/contexts/useWorkspaceContext";
import { normalizeWorkspacePath } from "../../../app/helpers";
import { useFileDrop } from "../../../lib/useFileDrop";
import type { EditorValueSelection } from "../../../types";
import { planWorkspaceMove } from "../workspaceTree";
import { FieldHelp } from "../../../components/FieldHelp";
import { WorkspaceConflictReview } from "./WorkspaceConflictReview";

const KlipperEditor = lazy(() => import("../../../KlipperEditor").then((module) => ({ default: module.KlipperEditor })));

export function WorkspaceEditor({ onOpenPublisher }: { onOpenPublisher: () => void }) {
  const {
    convertSelectionToVariable,
    updateVariable,
    values,
  } = usePackageContext();
  const {
    packageVariables,
    workspaceFilePath,
    currentWorkspaceContent,
    safetyFindings,
    workspaceChanged,
    draftSaveStatus,
    draftSavedAt,
    safetyBlocked,
    updateWorkspaceContent,
    importWorkspaceFiles,
    renameWorkspaceFile,
    pendingWorkspaceFiles,
    editorJumpTarget,
  } = useWorkspaceContext();
  const { reviewWorkspaceConflict, workspaceConflictBusy, workspaceConflictStatus, syncConflict, syncPullUrl } = useRepositoryContext();
  const linkedToPrinter = Boolean(syncPullUrl);

  const { isDragActive, dropProps } = useFileDrop(
    (files) => void importWorkspaceFiles(Array.from(files)),
  );
  const [renamingHeader, setRenamingHeader] = useState(false);
  const [renameHeaderPath, setRenameHeaderPath] = useState("");
  const [headerRenameError, setHeaderRenameError] = useState("");
  const [variableFeedback, setVariableFeedback] = useState("");
  const [lastEditAt, setLastEditAt] = useState<number | null>(null);

  // Every edit auto-saves as a working draft on idle. Track the newest edit
  // against the last autosave timestamp to show a precise "Saving…" → "saved"
  // indicator without reaching into the debounce timer.
  function handleEditorChange(value: string) {
    setLastEditAt(Date.now());
    updateWorkspaceContent(value);
  }

  const autosavePending = lastEditAt !== null
    && (!draftSavedAt || new Date(draftSavedAt).getTime() < lastEditAt);
  const autosaveLabel = autosavePending
    ? "Saving…"
    : workspaceChanged
      ? draftSaveStatus
      : "All changes saved";

  function beginHeaderRename() {
    if (!workspaceFilePath) return;
    setRenameHeaderPath(workspaceFilePath);
    setHeaderRenameError("");
    setRenamingHeader(true);
  }

  // Renames used to report only through a build status this view never
  // renders, silently no-opping on invalid paths. Validate with the same
  // planner the file browser uses and surface the error beside the input.
  function commitHeaderRename() {
    if (!renameHeaderPath || renameHeaderPath === workspaceFilePath) {
      setRenamingHeader(false);
      setHeaderRenameError("");
      return;
    }
    const destinationPath = normalizeWorkspacePath(renameHeaderPath);
    if (!destinationPath) {
      setHeaderRenameError("Enter a valid relative .cfg path.");
      return;
    }
    const plan = planWorkspaceMove(pendingWorkspaceFiles, workspaceFilePath, destinationPath, "file");
    if (plan.error) {
      setHeaderRenameError(plan.error);
      return;
    }
    setHeaderRenameError("");
    renameWorkspaceFile(workspaceFilePath, renameHeaderPath);
    setRenamingHeader(false);
  }

  function cancelHeaderRename() {
    setRenamingHeader(false);
    setHeaderRenameError("");
  }

  function createVariable(selection: EditorValueSelection, name: string) {
    const created = convertSelectionToVariable(workspaceFilePath, selection, name);
    if (created) {
      setVariableFeedback(`Created \${KLIPPEE:${name}}. The selected text is its initial printer value; select the placeholder to change it.`);
    }
    return created;
  }

  function setVariableValue(name: string, value: string) {
    updateVariable(name, value);
    setVariableFeedback(`Updated the printer value for \${KLIPPEE:${name}}.`);
  }

  return (
    <Card
      className={isDragActive ? "slicer-editor is-drop-target" : "slicer-editor"}
      {...dropProps}
    >
      <header className="slicer-editor-header">
        <div className="slicer-editor-header-title">
          {renamingHeader ? (
            <TextInput
              aria-label={`Rename ${workspaceFilePath}`}
              aria-invalid={headerRenameError ? true : undefined}
              autoFocus
              className="slicer-editor-header-rename"
              onBlur={commitHeaderRename}
              onChange={(event) => {
                setRenameHeaderPath(event.target.value);
                setHeaderRenameError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitHeaderRename();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelHeaderRename();
                }
              }}
              value={renameHeaderPath}
            />
          ) : (
            <Title order={2}>{workspaceFilePath || "No config file selected"}</Title>
          )}
          {workspaceFilePath && !renamingHeader ? (
            <ActionIcon
              aria-label={`Rename ${workspaceFilePath}`}
              className="icon-button"
              onClick={beginHeaderRename}
              size={44}
              variant="subtle"
            >
              <Pencil size={16} />
            </ActionIcon>
          ) : null}
        </div>
        <div className="slicer-editor-header-actions">
          <Button className="inline-action workspace-publish-action" leftSection={<PackageOpen size={16} />} onClick={onOpenPublisher} variant="subtle">Publish to Shared Configs</Button>
        </div>
      </header>
      {headerRenameError ? (
        <div className="workspace-operation-panel">
          <p className="workspace-operation-error" role="alert">{headerRenameError}</p>
        </div>
      ) : null}
      {variableFeedback ? <div className="editor-variable-feedback" role="status">{variableFeedback}</div> : null}
      {syncConflict ? (
        <div className="workspace-operation-panel" role="alert">
          <strong>Draft conflict</strong>
          <p>
            The cloud configuration changed after your workspace baseline. Your local edits are preserved.
            Review both versions before this draft can sync again.
          </p>
          <div>
            <Button className="inline-action" disabled={workspaceConflictBusy} onClick={() => void reviewWorkspaceConflict()} variant="subtle">
              {workspaceConflictBusy ? "Loading review…" : "Review conflict"}
            </Button>
          </div>
          {workspaceConflictStatus && <p role="status">{workspaceConflictStatus}</p>}
        </div>
      ) : null}
      <Suspense fallback={<div className="editor-loading" role="status">Loading editor...</div>}>
        <KlipperEditor
          filePath={workspaceFilePath}
          findings={safetyFindings}
          key={workspaceFilePath}
          onChange={handleEditorChange}
          onCreateVariable={createVariable}
          onUpdateVariable={setVariableValue}
          scrollToLine={editorJumpTarget ?? undefined}
          value={currentWorkspaceContent}
          variableDefinitions={packageVariables}
          variableValues={values}
        />
      </Suspense>
      <div aria-label="Configuration autosave" role="group" className="workspace-sync-bar">
        <div className="workspace-autosave-status" role="status">
          <span aria-hidden="true" className={`autosave-dot ${autosavePending ? "is-saving" : "is-idle"}`} />
          <span>{autosaveLabel}</span>
        </div>
        {safetyBlocked || syncConflict ? <p className="workspace-sync-hint" role="status">
          {safetyBlocked
            ? "Resolve blocking safety findings before this configuration can sync."
            : "Sync is paused until you review and resolve the draft conflict."}
        </p> : <div className="workspace-sync-hint"><FieldHelp label="Configuration autosave">
          {linkedToPrinter ? "Your printer records a version the next time it applies this configuration."
            : "Connect a printer to sync this configuration and record versions."}
        </FieldHelp></div>}
      </div>
      <WorkspaceConflictReview />
    </Card>
  );
}
