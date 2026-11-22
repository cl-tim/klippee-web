import { useMemo, useState } from "react";
import type { Key } from "react-aria-components";
import { useAccountStorage } from "../../../app/contexts/useAccountStorage";
import { workspaceFolderKey } from "../workspaceTree";

/**
 * Expanded-folder state for the workspace tree, scoped per printer and
 * persisted through account storage so the tree reopens the way the user
 * left it. Returns react-aria `Key`s ready for the Tree's `expandedKeys`.
 */
export function useExpandedFolders(printerScope: string) {
  const { loadStored, saveStored } = useAccountStorage();
  const storageKey = `workspaceTreeExpanded.${printerScope}`;
  const [expandedFoldersByScope, setExpandedFoldersByScope] = useState<Record<string, string[]>>({});

  const storedExpandedFolders = useMemo(
    () => loadStored<string[]>(storageKey, []),
    [loadStored, storageKey],
  );
  const expandedKeys = useMemo(
    () => new Set<Key>(
      (expandedFoldersByScope[storageKey] ?? storedExpandedFolders).map(workspaceFolderKey),
    ),
    [expandedFoldersByScope, storageKey, storedExpandedFolders],
  );

  function persistExpandedKeys(keys: Set<Key>) {
    const folders = [...keys]
      .map(String)
      .filter((key) => key.startsWith("folder:"))
      .map((key) => key.slice(7));
    setExpandedFoldersByScope((current) => ({ ...current, [storageKey]: folders }));
    saveStored(storageKey, folders);
  }

  return { expandedKeys, persistExpandedKeys };
}
