import { ChevronRight, FileCode2, Folder, FolderOpen, Pencil, Trash2 } from "lucide-react";
import { Button as AriaButton, TreeItem, TreeItemContent } from "react-aria-components";
import { formatBytes } from "../../../app/format";
import type { ConfigFile } from "../../../types";
import { workspaceFileKey, workspaceFolderKey, type WorkspaceTreeNode } from "../workspaceTree";

export type WorkspaceTreeTarget = {
  kind: "file" | "folder";
  path: string;
};

/**
 * One workspace tree row (file or folder), rendered recursively inside the
 * react-aria-components Tree. Row-level rename/delete actions surface through
 * the callbacks so panel state stays in the file browser.
 */
export function WorkspaceTreeItem({
  node,
  onRequestDelete,
  onRequestRename,
  onSelectFile,
  onSelectFolder,
}: {
  node: WorkspaceTreeNode;
  onRequestDelete: (target: WorkspaceTreeTarget) => void;
  onRequestRename: (target: WorkspaceTreeTarget) => void;
  onSelectFile: (file: ConfigFile) => void;
  onSelectFolder: (path: string) => void;
}) {
  if (node.kind === "folder") {
    return (
      <TreeItem
        id={workspaceFolderKey(node.path)}
        onAction={() => onSelectFolder(node.path)}
        textValue={node.name}
      >
        <TreeItemContent>
          {({ isExpanded, level }) => (
            <div className="workspace-tree-row-content" style={{ paddingLeft: `${(level - 1) * 14}px` }}>
              <AriaButton aria-label={isExpanded ? "Collapse" : "Expand"} slot="chevron">
                <ChevronRight size={14} />
              </AriaButton>
              {isExpanded ? <FolderOpen aria-hidden size={17} /> : <Folder aria-hidden size={17} />}
              <span className="workspace-tree-name" title={node.path}>{node.name}</span>
              <span className="workspace-tree-meta">
                {node.children.length} {node.children.length === 1 ? "item" : "items"}
              </span>
              <span className="file-row-actions">
                <AriaButton
                  aria-label={`Rename folder ${node.path}`}
                  className="file-row-icon-button"
                  onPress={() => onRequestRename({ kind: "folder", path: node.path })}
                >
                  <Pencil size={14} />
                </AriaButton>
                <AriaButton
                  aria-label={`Delete folder ${node.path}`}
                  className="file-row-icon-button danger-icon-button"
                  onPress={() => onRequestDelete({ kind: "folder", path: node.path })}
                >
                  <Trash2 size={14} />
                </AriaButton>
              </span>
            </div>
          )}
        </TreeItemContent>
        {node.children.map((child) => (
          <WorkspaceTreeItem
            key={child.kind === "folder" ? workspaceFolderKey(child.path) : workspaceFileKey(child.path)}
            node={child}
            onRequestDelete={onRequestDelete}
            onRequestRename={onRequestRename}
            onSelectFile={onSelectFile}
            onSelectFolder={onSelectFolder}
          />
        ))}
      </TreeItem>
    );
  }

  return (
    <TreeItem
      id={workspaceFileKey(node.path)}
      onAction={() => onSelectFile(node.file)}
      textValue={node.name}
    >
      <TreeItemContent>
        {({ level }) => (
          <div className="workspace-tree-row-content" style={{ paddingLeft: `${(level - 1) * 14}px` }}>
            <span aria-hidden className="workspace-tree-chevron-spacer" />
            <AriaButton
              aria-label={node.name}
              className="workspace-tree-file-open"
              onPress={() => onSelectFile(node.file)}
            >
              <FileCode2 aria-hidden size={17} />
              <span className="workspace-tree-name" title={node.path}>{node.name}</span>
            </AriaButton>
            <span className="workspace-tree-meta">
              {formatBytes(new TextEncoder().encode(node.file.content).length)}
            </span>
            <span className="file-row-actions">
              <AriaButton
                aria-label={`Rename ${node.path}`}
                className="file-row-icon-button"
                onPress={() => onRequestRename({ kind: "file", path: node.path })}
              >
                <Pencil size={14} />
              </AriaButton>
              <AriaButton
                aria-label={`Delete ${node.path}`}
                className="file-row-icon-button danger-icon-button"
                onPress={() => onRequestDelete({ kind: "file", path: node.path })}
              >
                <Trash2 size={14} />
              </AriaButton>
            </span>
          </div>
        )}
      </TreeItemContent>
    </TreeItem>
  );
}
