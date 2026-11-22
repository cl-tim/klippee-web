import type { ConfigFile } from "../../types";

export type WorkspaceTreeNode =
  | {
      children: WorkspaceTreeNode[];
      kind: "folder";
      name: string;
      path: string;
    }
  | {
      file: ConfigFile;
      kind: "file";
      name: string;
      path: string;
    };

export type WorkspaceIncludeReference = {
  filePath: string;
  from: string;
  to: string;
};

export type WorkspaceMovePlan =
  | {
      error: string;
      files: null;
      includeReferences: WorkspaceIncludeReference[];
      movedPaths: Map<string, string>;
    }
  | {
      error: null;
      files: ConfigFile[];
      includeReferences: WorkspaceIncludeReference[];
      movedPaths: Map<string, string>;
    };

type MutableFolderNode = {
  children: Map<string, MutableFolderNode | WorkspaceTreeNode>;
  kind: "folder";
  name: string;
  path: string;
};

const includeLinePattern = /^(\s*\[include\s+)([^\]\r\n]+)(\]\s*(?:#.*)?)$/gim;

export function workspaceFolderKey(path: string) {
  return `folder:${path}`;
}

export function workspaceFileKey(path: string) {
  return `file:${path}`;
}

export function workspaceParentPath(path: string) {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

export function workspaceBasename(path: string) {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? path : path.slice(separator + 1);
}

export function joinWorkspacePath(folderPath: string, name: string) {
  return folderPath ? `${folderPath}/${name}` : name;
}

export function normalizeWorkspaceFolderPath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return normalized;
}

export function workspaceAncestorFolders(path: string) {
  const parts = workspaceParentPath(path).split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function buildWorkspaceTree(files: ConfigFile[], virtualFolders: string[] = []) {
  const root: MutableFolderNode = {
    children: new Map(),
    kind: "folder",
    name: "",
    path: "",
  };

  function ensureFolder(folderPath: string) {
    let current = root;
    const segments = folderPath.split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      const path = segments.slice(0, index + 1).join("/");
      const existing = current.children.get(name);
      if (existing?.kind === "folder") {
        current = existing as MutableFolderNode;
        continue;
      }
      const folder: MutableFolderNode = {
        children: new Map(),
        kind: "folder",
        name,
        path,
      };
      current.children.set(name, folder);
      current = folder;
    }
    return current;
  }

  virtualFolders.forEach((path) => ensureFolder(path));
  files.forEach((file) => {
    const folder = ensureFolder(workspaceParentPath(file.path));
    const name = workspaceBasename(file.path);
    folder.children.set(name, {
      file,
      kind: "file",
      name,
      path: file.path,
    });
  });

  function finalize(folder: MutableFolderNode): WorkspaceTreeNode[] {
    return [...folder.children.values()]
      .map((node): WorkspaceTreeNode => {
        if (node.kind === "file") {
          return node;
        }
        return {
          children: finalize(node as MutableFolderNode),
          kind: "folder",
          name: node.name,
          path: node.path,
        };
      })
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "folder" ? -1 : 1;
        }
        if (left.kind === "file" && right.kind === "file") {
          if (left.path === "printer.cfg") return -1;
          if (right.path === "printer.cfg") return 1;
        }
        return left.name.localeCompare(right.name);
      });
  }

  return finalize(root);
}

export function filterWorkspaceTree(nodes: WorkspaceTreeNode[], query: string): WorkspaceTreeNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  return nodes.flatMap((node): WorkspaceTreeNode[] => {
    if (node.kind === "file") {
      return node.path.toLocaleLowerCase().includes(normalizedQuery) ? [node] : [];
    }
    const children = filterWorkspaceTree(node.children, normalizedQuery);
    if (node.path.toLocaleLowerCase().includes(normalizedQuery) || children.length > 0) {
      return [{ ...node, children: node.path.toLocaleLowerCase().includes(normalizedQuery) ? node.children : children }];
    }
    return [];
  });
}

function mapWorkspacePath(path: string, sourcePath: string, destinationPath: string, kind: "file" | "folder") {
  if (kind === "file") {
    return path === sourcePath ? destinationPath : null;
  }
  if (path.startsWith(`${sourcePath}/`)) {
    return `${destinationPath}${path.slice(sourcePath.length)}`;
  }
  return null;
}

export function findWorkspaceIncludeReferences(
  files: ConfigFile[],
  sourcePath: string,
  destinationPath: string,
  kind: "file" | "folder",
) {
  const references: WorkspaceIncludeReference[] = [];
  files.forEach((file) => {
    for (const match of file.content.matchAll(includeLinePattern)) {
      const rawTarget = match[2].trim();
      const normalizedTarget = rawTarget.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
      const mappedTarget = mapWorkspacePath(normalizedTarget, sourcePath, destinationPath, kind);
      if (mappedTarget) {
        references.push({
          filePath: file.path,
          from: rawTarget,
          to: rawTarget.startsWith("./") ? `./${mappedTarget}` : mappedTarget,
        });
      }
    }
  });
  return references;
}

export function planWorkspaceMove(
  files: ConfigFile[],
  sourcePath: string,
  destinationPath: string,
  kind: "file" | "folder",
): WorkspaceMovePlan {
  if (sourcePath === destinationPath) {
    return { error: "Choose a different destination", files: null, includeReferences: [], movedPaths: new Map() };
  }
  if (kind === "folder" && destinationPath.startsWith(`${sourcePath}/`)) {
    return {
      error: "A folder cannot be moved inside itself",
      files: null,
      includeReferences: [],
      movedPaths: new Map(),
    };
  }

  const movedPaths = new Map<string, string>();
  files.forEach((file) => {
    const mappedPath = mapWorkspacePath(file.path, sourcePath, destinationPath, kind);
    if (mappedPath) {
      movedPaths.set(file.path, mappedPath);
    }
  });
  if (movedPaths.size === 0) {
    return { error: `${sourcePath} was not found`, files: null, includeReferences: [], movedPaths };
  }

  const unmovedPaths = new Set(files.filter((file) => !movedPaths.has(file.path)).map((file) => file.path));
  const conflict = [...movedPaths.values()].find((path) => unmovedPaths.has(path));
  if (conflict) {
    return { error: `${conflict} already exists`, files: null, includeReferences: [], movedPaths };
  }

  const includeReferences = findWorkspaceIncludeReferences(files, sourcePath, destinationPath, kind);
  const replacementsByFile = new Map<string, WorkspaceIncludeReference[]>();
  includeReferences.forEach((reference) => {
    const references = replacementsByFile.get(reference.filePath) ?? [];
    references.push(reference);
    replacementsByFile.set(reference.filePath, references);
  });

  const movedFiles = files.map((file) => {
    const nextPath = movedPaths.get(file.path) ?? file.path;
    const references = replacementsByFile.get(file.path) ?? [];
    const content = references.length === 0
      ? file.content
      : file.content.replace(includeLinePattern, (line) => {
          const reference = references.find((candidate) => line.includes(candidate.from));
          return reference ? line.replace(reference.from, () => reference.to) : line;
        });
    return { ...file, content, path: nextPath };
  });

  return { error: null, files: movedFiles, includeReferences, movedPaths };
}
