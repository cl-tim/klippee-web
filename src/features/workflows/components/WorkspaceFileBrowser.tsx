import {
  ChevronRight,
  FileCode2,
  FolderPlus,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Tree, type Key, type Selection } from "react-aria-components";
import { ActionIcon, Button, TextInput } from "@mantine/core";
import { Card } from "@/components/ui/card";
import { usePrinterContext } from "../../../app/contexts/usePrinterContext";
import { useWorkspaceContext } from "../../../app/contexts/useWorkspaceContext";
import { normalizeWorkspacePath } from "../../../app/helpers";
import { useFileDrop } from "../../../lib/useFileDrop";
import type { ConfigFile } from "../../../types";
import {
  buildWorkspaceTree,
  filterWorkspaceTree,
  findWorkspaceIncludeReferences,
  joinWorkspacePath,
  normalizeWorkspaceFolderPath,
  planWorkspaceMove,
  workspaceAncestorFolders,
  workspaceBasename,
  workspaceFileKey,
  workspaceFolderKey,
  workspaceParentPath,
  type WorkspaceTreeNode,
} from "../workspaceTree";
import { DeleteConfirmPanel, type PendingWorkspaceDelete } from "./DeleteConfirmPanel";
import { RenameMovePanel, type PendingWorkspaceMove } from "./RenameMovePanel";
import { FieldHelp } from "../../../components/FieldHelp";
import { useExpandedFolders } from "./useExpandedFolders";
import { WorkspaceTreeItem, type WorkspaceTreeTarget } from "./WorkspaceTreeItem";

function collectFolderKeys(nodes: WorkspaceTreeNode[]) {
  return nodes.flatMap((node): string[] =>
    node.kind === "folder"
      ? [workspaceFolderKey(node.path), ...collectFolderKeys(node.children)]
      : [],
  );
}

export function WorkspaceFileBrowser({ onFileSelected }: { onFileSelected?: () => void }) {
  const {
    pendingWorkspaceFiles,
    workspaceFilePath,
    importWorkspaceFiles,
    createWorkspaceFile,
    deleteWorkspaceFolder,
    deleteWorkspaceFile,
    renameWorkspaceFile,
    renameWorkspaceFolder,
    selectWorkspaceFile,
  } = useWorkspaceContext();
  const { selectedPrinterId } = usePrinterContext();
  const importInputRef = useRef<HTMLInputElement>(null);

  const printerScope = selectedPrinterId || "local";
  const { isDragActive, dropProps } = useFileDrop(
    (files) => void importWorkspaceFiles(Array.from(files)),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [folderSelection, setFolderSelection] = useState(() => ({
    active: false,
    path: workspaceParentPath(workspaceFilePath),
    printerScope,
  }));
  const [newFileName, setNewFileName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [showFolderForm, setShowFolderForm] = useState(false);
  const [virtualFolderState, setVirtualFolderState] = useState<{ folders: string[]; printerScope: string }>({
    folders: [],
    printerScope,
  });
  const { expandedKeys, persistExpandedKeys } = useExpandedFolders(printerScope);
  const [renameTarget, setRenameTarget] = useState<WorkspaceTreeTarget | null>(null);
  const [renamePath, setRenamePath] = useState("");
  const [renameError, setRenameError] = useState("");
  const [pendingMove, setPendingMove] = useState<PendingWorkspaceMove | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingWorkspaceDelete | null>(null);
  const selectedFolder = folderSelection.printerScope === printerScope
    ? folderSelection.path
    : workspaceParentPath(workspaceFilePath);
  const folderSelectionActive = folderSelection.printerScope === printerScope && folderSelection.active;

  const activeVirtualFolders = useMemo(
    () => {
      const folders = virtualFolderState.printerScope === printerScope ? virtualFolderState.folders : [];
      return folders.filter(
        (folder) => !pendingWorkspaceFiles.some((file) => file.path.startsWith(`${folder}/`)),
      );
    },
    [pendingWorkspaceFiles, printerScope, virtualFolderState],
  );
  const tree = useMemo(
    () => buildWorkspaceTree(pendingWorkspaceFiles, activeVirtualFolders),
    [activeVirtualFolders, pendingWorkspaceFiles],
  );
  const filteredTree = useMemo(() => filterWorkspaceTree(tree, searchQuery), [searchQuery, tree]);
  const visibleExpandedKeys = useMemo(
    () => new Set<Key>([
      ...expandedKeys,
      ...workspaceAncestorFolders(workspaceFilePath).map(workspaceFolderKey),
      ...(searchQuery.trim() ? collectFolderKeys(filteredTree) : []),
    ]),
    [expandedKeys, filteredTree, searchQuery, workspaceFilePath],
  );
  const selectedKeys = folderSelectionActive
    ? selectedFolder
      ? new Set([workspaceFolderKey(selectedFolder)])
      : new Set<string>()
    : new Set([workspaceFileKey(workspaceFilePath)]);

  function updateVirtualFolders(update: string[] | ((current: string[]) => string[])) {
    setVirtualFolderState((current) => {
      const currentFolders = current.printerScope === printerScope ? current.folders : [];
      return {
        folders: typeof update === "function" ? update(currentFolders) : update,
        printerScope,
      };
    });
  }

  function updateFolderSelection(path: string, active: boolean) {
    setFolderSelection({ active, path, printerScope });
  }

  function selectFolder(path: string) {
    updateFolderSelection(path, true);
    const next = new Set(expandedKeys);
    workspaceAncestorFolders(`${path}/placeholder.cfg`).forEach((ancestor) => next.add(workspaceFolderKey(ancestor)));
    persistExpandedKeys(next);
  }

  function selectFile(file: ConfigFile) {
    updateFolderSelection(workspaceParentPath(file.path), false);
    selectWorkspaceFile(file);
    onFileSelected?.();
  }

  function handleTreeSelectionChange(selection: Selection) {
    if (selection === "all") return;
    const key = [...selection][0];
    if (typeof key !== "string") return;
    if (key.startsWith("folder:")) {
      selectFolder(key.slice(7));
      return;
    }
    if (key.startsWith("file:")) {
      const file = pendingWorkspaceFiles.find((candidate) => candidate.path === key.slice(5));
      if (file) selectFile(file);
    }
  }

  function requestRename(target: WorkspaceTreeTarget) {
    setRenameTarget(target);
    setRenamePath(target.path);
    setRenameError("");
    setPendingMove(null);
  }

  function cancelRename() {
    setRenameTarget(null);
    setRenameError("");
    setPendingMove(null);
  }

  function updateRenamePath(path: string) {
    setRenamePath(path);
    setRenameError("");
    setPendingMove(null);
  }

  function applyMove(move: PendingWorkspaceMove) {
    if (move.kind === "file") {
      renameWorkspaceFile(move.path, move.destinationPath);
      updateFolderSelection(workspaceParentPath(move.destinationPath), false);
    } else {
      renameWorkspaceFolder(move.path, move.destinationPath);
      updateFolderSelection(move.destinationPath, true);
      updateVirtualFolders((current) =>
        current.map((folder) =>
          folder === move.path || folder.startsWith(`${move.path}/`)
            ? `${move.destinationPath}${folder.slice(move.path.length)}`
          : folder,
        ),
      );
      const nextExpandedKeys = new Set(expandedKeys);
      [...nextExpandedKeys].forEach((key) => {
        const keyValue = String(key);
        const sourceKey = workspaceFolderKey(move.path);
        if (keyValue === sourceKey || keyValue.startsWith(`${sourceKey}/`)) {
          nextExpandedKeys.delete(key);
          nextExpandedKeys.add(
            workspaceFolderKey(`${move.destinationPath}${keyValue.slice(sourceKey.length)}`),
          );
        }
      });
      nextExpandedKeys.add(workspaceFolderKey(move.destinationPath));
      persistExpandedKeys(nextExpandedKeys);
    }
    cancelRename();
  }

  function submitRename() {
    if (!renameTarget) return;
    const destinationPath = renameTarget.kind === "file"
      ? normalizeWorkspacePath(renamePath)
      : normalizeWorkspaceFolderPath(renamePath);
    if (!destinationPath) {
      setRenameError(
        renameTarget.kind === "file"
          ? "Enter a valid relative .cfg path."
          : "Enter a valid relative folder path.",
      );
      return;
    }
    const plan = planWorkspaceMove(
      pendingWorkspaceFiles,
      renameTarget.path,
      destinationPath,
      renameTarget.kind,
    );
    if (plan.error) {
      setRenameError(plan.error);
      return;
    }
    setRenameError("");
    const includeCount = plan.includeReferences.length;
    const move = { ...renameTarget, destinationPath, includeCount };
    if (includeCount > 0) {
      setPendingMove(move);
      return;
    }
    applyMove(move);
  }

  function requestDelete(target: WorkspaceTreeTarget) {
    const affectedFiles = target.kind === "file"
      ? pendingWorkspaceFiles.filter((file) => file.path === target.path)
      : pendingWorkspaceFiles.filter((file) => file.path.startsWith(`${target.path}/`));
    const includeCount = findWorkspaceIncludeReferences(
      pendingWorkspaceFiles,
      target.path,
      "__deleted__",
      target.kind,
    ).length;
    setPendingDelete({ ...target, fileCount: affectedFiles.length, includeCount });
  }

  function confirmDelete(target: PendingWorkspaceDelete) {
    if (target.kind === "file") {
      deleteWorkspaceFile(target.path);
    } else {
      deleteWorkspaceFolder(target.path);
      updateVirtualFolders((current) =>
        current.filter((folder) => folder !== target.path && !folder.startsWith(`${target.path}/`)),
      );
      updateFolderSelection("", true);
    }
    setPendingDelete(null);
  }

  const breadcrumbs = selectedFolder.split("/").filter(Boolean);

  return (
    <Card
      className={isDragActive ? "slicer-file-card is-drop-target" : "slicer-file-card"}
      {...dropProps}
    >
      <div className="file-browser-title">
        <FileCode2 size={18} />
        <h3>Configuration Files</h3>
        <span>{pendingWorkspaceFiles.length}</span>
        {activeVirtualFolders.length > 0 && <FieldHelp label="Configuration folders">Empty folders are local until a config file is created inside them.</FieldHelp>}
      </div>

      <div aria-label="Current folder" role="group" className="workspace-breadcrumbs">
        <Button
          className={!selectedFolder ? "is-current" : ""}
          onClick={() => updateFolderSelection("", true)}
          variant="subtle"
        >
          Root
        </Button>
        {breadcrumbs.map((part, index) => {
          const path = breadcrumbs.slice(0, index + 1).join("/");
          return (
            <span key={path}>
              <ChevronRight aria-hidden size={12} />
              <Button
                className={index === breadcrumbs.length - 1 ? "is-current" : ""}
                onClick={() => selectFolder(path)}
                variant="subtle"
              >
                {part}
              </Button>
            </span>
          );
        })}
      </div>

      <div className="file-browser-toolbar">
        <label className="workspace-tree-search">
          <Search aria-hidden size={15} />
          <TextInput
            aria-label="Search configuration files"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search files"
            style={{ flex: 1, minWidth: 0 }}
            type="search"
            value={searchQuery}
            variant="unstyled"
            w="100%"
          />
        </label>
        <div className="file-browser-actions">
          <ActionIcon
            aria-expanded={showFolderForm}
            aria-label="New folder"
            className="icon-button"
            onClick={() => setShowFolderForm((current) => !current)}
            size={44}
            variant="subtle"
          >
            <FolderPlus size={16} />
          </ActionIcon>
          <ActionIcon
            aria-label="Upload CFG"
            className="icon-button file-import-action"
            onClick={() => importInputRef.current?.click()}
            size={44}
            variant="subtle"
          >
            <Upload size={16} />
          </ActionIcon>
          <input
            accept=".cfg,text/plain"
            hidden
            multiple
            onChange={(event) => {
              void importWorkspaceFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            ref={importInputRef}
            type="file"
          />
        </div>
      </div>

      {showFolderForm ? (
        <form
          className="file-browser-create"
          onSubmit={(event) => {
            event.preventDefault();
            const path = normalizeWorkspaceFolderPath(joinWorkspacePath(selectedFolder, newFolderName));
            if (!path) return;
            updateVirtualFolders((current) => current.includes(path) ? current : [...current, path]);
            setNewFolderName("");
            setShowFolderForm(false);
            selectFolder(path);
          }}
        >
          <TextInput
            aria-label={`New folder inside ${selectedFolder || "root"}`}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="Folder name"
            style={{ flex: 1, minWidth: 0 }}
            value={newFolderName}
          />
          <Button className="inline-action" type="submit">Add folder</Button>
        </form>
      ) : null}

      <form
        className="file-browser-create"
        onSubmit={(event) => {
          event.preventDefault();
          const path = joinWorkspacePath(selectedFolder, newFileName);
          createWorkspaceFile(path);
          updateVirtualFolders((current) => current.filter((folder) => folder !== selectedFolder));
          updateFolderSelection(selectedFolder, false);
          setNewFileName("");
        }}
      >
        <TextInput
          aria-label="New config file path"
          onChange={(event) => setNewFileName(event.target.value)}
          placeholder={selectedFolder ? `New file in ${workspaceBasename(selectedFolder)}` : "New config file"}
          style={{ flex: 1, minWidth: 0 }}
          value={newFileName}
        />
        <Button className="inline-action" leftSection={<Plus size={14} />} type="submit">Create</Button>
      </form>

      {renameTarget ? (
        <RenameMovePanel
          onCancel={cancelRename}
          onConfirmMove={applyMove}
          onPathChange={updateRenamePath}
          onSubmit={submitRename}
          pendingMove={pendingMove}
          renameError={renameError}
          renamePath={renamePath}
          target={renameTarget}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteConfirmPanel
          key={`${pendingDelete.kind}:${pendingDelete.path}`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => confirmDelete(pendingDelete)}
          target={pendingDelete}
        />
      ) : null}

      <Tree
        aria-label="Configuration files"
        className="workspace-tree"
        expandedKeys={visibleExpandedKeys}
        onExpandedChange={(keys) => {
          const next = new Set(keys);
          persistExpandedKeys(next);
        }}
        onSelectionChange={handleTreeSelectionChange}
        selectedKeys={selectedKeys}
        selectionBehavior="replace"
        selectionMode="single"
      >
        {filteredTree.map((node) => (
          <WorkspaceTreeItem
            key={node.kind === "folder" ? workspaceFolderKey(node.path) : workspaceFileKey(node.path)}
            node={node}
            onRequestDelete={requestDelete}
            onRequestRename={requestRename}
            onSelectFile={selectFile}
            onSelectFolder={selectFolder}
          />
        ))}
      </Tree>
      {filteredTree.length === 0 ? (
        <p className="workspace-tree-empty">
          {searchQuery.trim()
            ? `No configuration files match “${searchQuery}”.`
            : "No configuration files yet"}
        </p>
      ) : null}
    </Card>
  );
}
