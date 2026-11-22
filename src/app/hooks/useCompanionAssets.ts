import { useState } from "react";
import type { CompanionAsset } from "../../types";
import type { CompanionAssetDraft, CompanionAssetImport } from "../types";
import { usePersistedState } from "./usePersistedState";

const emptyDraft: CompanionAssetDraft = {
  content: "",
  description: "",
  kind: "filament",
  tags: "",
  title: "",
};

type CompanionAssetEditorState = {
  draft: CompanionAssetDraft;
  editingAssetId: string | null;
  selectedAssetId: string;
};

function editorScope(printerId: string | null) {
  return printerId ?? "unassigned";
}

function initialEditorState(assets: CompanionAsset[], printerId: string | null): CompanionAssetEditorState {
  const firstAsset = printerId
    ? assets.find((asset) => asset.printerId === printerId || !asset.printerId)
    : assets[0];
  return {
    draft: emptyDraft,
    editingAssetId: null,
    selectedAssetId: firstAsset?.id ?? "",
  };
}

function draftFromAsset(asset: CompanionAsset): CompanionAssetDraft {
  return {
    content: asset.content,
    description: asset.description,
    kind: asset.kind,
    printerId: asset.printerId ?? null,
    tags: asset.tags.join(", "),
    title: asset.title,
    structured: asset.structured as Record<string, string> | undefined,
  };
}

export function useCompanionAssets(initialAssets: CompanionAsset[], activePrinterId: string | null) {
  const [companionAssets, setCompanionAssets] = usePersistedState<CompanionAsset[]>(
    "companionAssets",
    initialAssets,
  );
  const scope = editorScope(activePrinterId);
  const [editorStates, setEditorStates] = useState<Record<string, CompanionAssetEditorState>>(() => ({
    [scope]: initialEditorState(initialAssets, activePrinterId),
  }));
  const editorState = editorStates[scope] ?? initialEditorState(companionAssets, activePrinterId);
  const { draft: companionAssetDraft, editingAssetId: editingCompanionAssetId, selectedAssetId: selectedCompanionAssetId } = editorState;

  function updateEditorState(update: (current: CompanionAssetEditorState) => CompanionAssetEditorState) {
    setEditorStates((current) => ({
      ...current,
      [scope]: update(current[scope] ?? initialEditorState(companionAssets, activePrinterId)),
    }));
  }

  function assetBelongsToActivePrinter(asset: CompanionAsset) {
    // The account-wide Orca editor also opens formerly printer-scoped assets.
    return activePrinterId === null || asset.printerId === activePrinterId || asset.printerId == null;
  }

  const selectedCompanionAsset = companionAssets.find(
    (asset) => asset.id === selectedCompanionAssetId && assetBelongsToActivePrinter(asset),
  ) ?? null;

  function updateCompanionAssetDraft(field: keyof CompanionAssetDraft, value: string) {
    updateEditorState((current) => ({ ...current, draft: { ...current.draft, [field]: value } }));
  }

  function updateCompanionAssetStructured(field: string, value: string) {
    updateEditorState((current) => ({
      ...current,
      draft: { ...current.draft, structured: { ...(current.draft.structured ?? {}), [field]: value } },
    }));
  }

  /** Load an existing asset into this printer's edit form. */
  function loadCompanionAssetForEdit(id: string) {
    const asset = companionAssets.find((candidate) => candidate.id === id);
    if (!asset || !assetBelongsToActivePrinter(asset)) return;
    updateEditorState((current) => ({
      ...current,
      draft: draftFromAsset(asset),
      editingAssetId: id,
      selectedAssetId: id,
    }));
  }

  /** Reset this printer's form to create a new asset of the given kind. */
  function startNewCompanionAsset(kind: CompanionAsset["kind"], printerId: string | null = activePrinterId) {
    if (printerId !== activePrinterId) return;
    updateEditorState((current) => ({
      ...current,
      draft: { ...emptyDraft, kind, printerId },
      editingAssetId: null,
    }));
  }

  /**
   * Create assets from imported presets (bundles can yield several at once),
   * bypassing the single-slot draft. Selects the first created asset for
   * editing. Returns the created assets so callers can persist them to the
   * cloud.
   */
  function addImportedCompanionAssets(inputs: CompanionAssetImport[]): CompanionAsset[] {
    if (!inputs.length) return [];
    const now = new Date().toISOString();
    const base = Date.now().toString(36);
    const created: CompanionAsset[] = inputs.map((input, index) => ({
      id: `companion-${base}-${index}`,
      kind: input.kind,
      printerId: input.printerId ?? activePrinterId,
      title: input.title,
      description: "",
      content: input.content,
      tags: input.tags ?? [],
      public: false,
      version: "1",
      createdAt: now,
      updatedAt: now,
    }));
    setCompanionAssets((current) => {
      return [...created, ...current];
    });
    const first = created[0];
    if (first.printerId === activePrinterId) {
      updateEditorState((current) => ({
        ...current,
        draft: draftFromAsset(first),
        editingAssetId: first.id,
        selectedAssetId: first.id,
      }));
    }
    return created;
  }

  /**
   * Assign a set of assets to a printer (used for the one-time migration of
   * legacy, unassigned presets). Returns the updated assets so callers can
   * persist them to the cloud.
   */
  function assignCompanionAssetsToPrinter(printerId: string, ids: string[]): CompanionAsset[] {
    if (!ids.length) return [];
    const idSet = new Set(ids);
    const now = new Date().toISOString();
    let updated: CompanionAsset[] = [];
    setCompanionAssets((current) => {
      const next = current.map((asset) => (idSet.has(asset.id) ? { ...asset, printerId, updatedAt: now } : asset));
      updated = next.filter((asset) => idSet.has(asset.id));
      return next;
    });
    return updated;
  }

  /** Delete a saved asset by id from the active printer's workspace. */
  function deleteCompanionAsset(id: string) {
    const asset = companionAssets.find((candidate) => candidate.id === id);
    if (!asset || !assetBelongsToActivePrinter(asset)) return;
    setCompanionAssets((current) => current.filter((candidate) => candidate.id !== id));
    setEditorStates(current => Object.fromEntries(Object.entries(current).map(([key, state]) => [key, {
      ...state,
      draft: state.editingAssetId === id ? emptyDraft : state.draft,
      editingAssetId: state.editingAssetId === id ? null : state.editingAssetId,
      selectedAssetId: state.selectedAssetId === id ? "" : state.selectedAssetId,
    }])));
  }

  /** Save the active printer's draft, returning null if it is invalid or stale. */
  function saveCompanionAsset(): CompanionAsset | null {
    const title = companionAssetDraft.title.trim();
    if (!title) return null;

    const now = new Date().toISOString();
    const structured = companionAssetDraft.structured && Object.keys(companionAssetDraft.structured).length
      ? companionAssetDraft.structured
      : undefined;
    const tags = companionAssetDraft.tags.split(",").map((tag) => tag.trim()).filter(Boolean);

    if (editingCompanionAssetId) {
      const existing = companionAssets.find((asset) => asset.id === editingCompanionAssetId);
      if (!existing || !assetBelongsToActivePrinter(existing)) return null;
      const updated: CompanionAsset = {
        ...existing,
        title,
        description: companionAssetDraft.description.trim(),
        content: companionAssetDraft.content,
        tags,
        structured,
        updatedAt: now,
      };
      setCompanionAssets((current) => current.map((asset) => (
        asset.id === updated.id ? updated : asset
      )));
      return updated;
    }

    if (companionAssetDraft.printerId && companionAssetDraft.printerId !== activePrinterId) return null;
    const asset: CompanionAsset = {
      content: companionAssetDraft.content,
      createdAt: now,
      description: companionAssetDraft.description.trim(),
      id: `companion-${Date.now().toString(36)}`,
      kind: companionAssetDraft.kind,
      printerId: companionAssetDraft.printerId ?? activePrinterId,
      public: false,
      tags,
      title,
      updatedAt: now,
      version: "1",
      structured,
    };
    setCompanionAssets((current) => [asset, ...current]);
    updateEditorState((current) => ({
      ...current,
      draft: draftFromAsset(asset),
      editingAssetId: asset.id,
      selectedAssetId: asset.id,
    }));
    return asset;
  }

  function setSelectedCompanionAssetId(id: string) {
    updateEditorState((current) => ({ ...current, selectedAssetId: id }));
  }

  return {
    companionAssetDraft,
    companionAssets,
    editingCompanionAssetId,
    addImportedCompanionAssets,
    assignCompanionAssetsToPrinter,
    deleteCompanionAsset,
    loadCompanionAssetForEdit,
    saveCompanionAsset,
    selectedCompanionAsset,
    selectedCompanionAssetId,
    setCompanionAssets,
    setSelectedCompanionAssetId,
    startNewCompanionAsset,
    updateCompanionAssetDraft,
    updateCompanionAssetStructured,
  };
}
