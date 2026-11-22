import { tabLabels } from "../../app/constants";
import { WorkflowButton, WorkflowInput, WorkflowTextarea } from "./WorkflowControls";
import { Button, Tabs, UnstyledButton } from "@mantine/core";
import { HelpRow } from "../../components/FieldHelp";
import { FileJson, Plus, Save, Search, Share2, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppShellContext } from "../../app/contexts/useAppShellContext";
import { useCompanionAssetContext } from "../../app/contexts/useCompanionAssetContext";
import { usePackageContext } from "../../app/contexts/usePackageContext";
import { formatDate } from "../../app/format";
import type { CompanionAssetImport } from "../../app/types";
import {
  isBundleName,
  orcaBundleCompressedSizeError,
  orcaPresetFileSizeError,
  readOrcaBundle,
  readOrcaPresetFile,
} from "../orca/orcaBundle";
import {
  getPresetField,
  parseOrcaPreset,
  presetDisplayName,
  serializeOrcaPreset,
  setPresetField,
  type OrcaFieldShape,
  type OrcaPresetType,
} from "../orca/orcaPreset";
import { buildEditorModel, type EditorField } from "../orca/orcaSchema";
import { OrcaConnectionPanel } from "../orca/OrcaConnectionPanel";

// The three preset groups, in the order they list in the sidebar.
const GROUPS: Array<{ type: OrcaPresetType; label: string; newLabel: string }> = [
  { type: "machine", label: "Printers", newLabel: "New printer" },
  { type: "process", label: "Processes", newLabel: "New process" },
  { type: "filament", label: "Filaments", newLabel: "New filament" },
];

const ACCEPT = ".json,.orca_filament,.orca_printer,.orca_process,.zip";

// ─── Public entry point ─────────────────────────────────────────────────────────

export function OrcaWorkspaceView() {
  return <OrcaWorkspace />;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Write the display name into the raw preset JSON, keeping them in sync. */
function withPresetName(content: string, name: string): string {
  const parsed = parseOrcaPreset(content);
  if (!parsed) return content;
  return serializeOrcaPreset({ ...parsed.json, name });
}

/** A minimal, valid starter preset of the given type. */
function starterPreset(type: OrcaPresetType): string {
  return serializeOrcaPreset({ type, name: "", from: "User" });
}

function matchesQuery(field: EditorField, query: string): boolean {
  if (!query) return true;
  return field.key.toLowerCase().includes(query) || field.label.toLowerCase().includes(query);
}

// ─── Main workspace ────────────────────────────────────────────────────────────

function OrcaWorkspace() {
  const { authUser } = useAppShellContext();
  const [workspaceView, setWorkspaceView] = useState<"setups" | "editor">("setups");
  const {
    companionAssets,
    companionAssetDraft,
    companionAssetStatus,
    editingCompanionAssetId,
    selectedCompanionAssetId,
    linkedCompanionAssets,
    deleteCompanionAsset,
    importCompanionAssets,
    loadCompanionAssetForEdit,
    startNewCompanionAsset,
    updateCompanionAssetDraft,
    linkSelectedCompanionAssetToPackage,
    publishSelectedCompanionAsset,
    saveCompanionAsset,
  } = useCompanionAssetContext();
  const { selectedPackage } = usePackageContext();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [activePresetTab, setActivePresetTab] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteFailedId, setDeleteFailedId] = useState("");
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const lastDeleteTarget = useRef("");

  useEffect(() => {
    if (pendingDeleteId) cancelDeleteRef.current?.focus();
    else if (lastDeleteTarget.current === editingCompanionAssetId) deleteButtonRef.current?.focus();
  }, [pendingDeleteId, editingCompanionAssetId]);

  async function confirmDelete(id: string) {
    setDeleting(true); setDeleteFailedId("");
    try {
      const removed = await deleteCompanionAsset(id);
      if (removed) setPendingDeleteId(current => current === id ? "" : current);
      else setDeleteFailedId(id);
    } catch { setDeleteFailedId(id); }
    finally { setDeleting(false); }
  }

  const printerId = null;

  // Parse once per asset-list change; profiles are shared across the account.
  const parsedAssets = useMemo(
    () => companionAssets.map((asset) => ({ asset, preset: parseOrcaPreset(asset.content) })),
    [companionAssets],
  );

  const draftPreset = useMemo(() => parseOrcaPreset(companionAssetDraft.content), [companionAssetDraft.content]);
  const isEditing = editingCompanionAssetId !== null;
  const canSave = companionAssetDraft.title.trim().length > 0 && draftPreset !== null
    && ["machine", "filament", "process"].includes(companionAssetDraft.kind);

  const model = useMemo(
    () => (draftPreset ? buildEditorModel(draftPreset.json, draftPreset.type) : null),
    [draftPreset],
  );
  const query = search.trim().toLowerCase();

  const tabs = model?.tabs ?? [];
  const currentTab = tabs.find((tab) => tab.title === activePresetTab) ?? tabs[0] ?? null;

  const searchSections: Array<{ caption: string; fields: EditorField[] }> = tabs.flatMap((tab) =>
    tab.sections.map((section) => ({
      caption: section.title ? `${tab.title} › ${section.title}` : tab.title,
      fields: section.fields,
    })),
  );
  const matchedSections = searchSections
    .map((section) => ({ caption: section.caption, fields: section.fields.filter((field) => matchesQuery(field, query)) }))
    .filter((section) => section.fields.length > 0);
  const matchCount = matchedSections.reduce((total, section) => total + section.fields.length, 0);

  // Include formerly printer-associated files without reassigning ownership.
  const scopedAssets = parsedAssets.filter(
    ({ preset }) => preset !== null,
  );
  const printerAssets = parsedAssets.map(({ asset }) => asset);
  const otherAssets = parsedAssets.filter(({ preset }) => preset === null).map(({ asset }) => asset);
  const grouped = GROUPS.map((group) => ({
    ...group,
    items: scopedAssets.filter(({ preset }) => preset?.type === group.type).map(({ asset }) => asset),
  }));
  const linkedIds = new Set(linkedCompanionAssets.map((asset) => asset.id));
  const selectedAsset = printerAssets.find((asset) => asset.id === selectedCompanionAssetId) ?? null;

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const inputs: CompanionAssetImport[] = [];
    const errors: string[] = [];
    for (const file of Array.from(fileList)) {
      const isBundle = isBundleName(file.name);
      const sizeError = isBundle
        ? orcaBundleCompressedSizeError(file.name, file.size)
        : orcaPresetFileSizeError(file.name, file.size);
      if (sizeError) {
        errors.push(sizeError);
        continue;
      }
      const result = isBundle
        ? readOrcaBundle(file.name, new Uint8Array(await file.arrayBuffer()))
        : readOrcaPresetFile(file.name, await file.text());
      errors.push(...result.errors);
      for (const entry of result.entries) {
        inputs.push({ kind: entry.preset.type, title: presetDisplayName(entry.preset), content: entry.raw, printerId });
      }
    }
    setImportErrors(errors);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (inputs.length) await importCompanionAssets(inputs);
  }

  function startNew(type: OrcaPresetType) {
    startNewCompanionAsset(type, printerId);
    updateCompanionAssetDraft("content", starterPreset(type));
    setSearch("");
  }

  function updateField(key: string, value: string, shape: OrcaFieldShape) {
    if (!draftPreset) return;
    updateCompanionAssetDraft("content", serializeOrcaPreset(setPresetField(draftPreset.json, key, value, shape)));
  }

  function renderField(field: EditorField) {
    const value = draftPreset ? getPresetField(draftPreset.json, field.key, field.control) : "";
    const isArea = field.control !== "scalar";
    return (
      <label className={isArea ? "orca-field is-area" : "orca-field"} key={field.key}>
        <span className="orca-field-label">
          <span className="orca-field-name">{field.label}</span>
          <code className="orca-field-key" title={field.key}>{field.key}</code>
        </span>
        {isArea ? (
          <WorkflowTextarea
            classNames={{ input: "code-editor orca-field-input" }}
            onChange={(event) => updateField(field.key, event.target.value, field.control)}
            rows={field.control === "multiline" ? 4 : 2}
            spellCheck={false}
            value={value}
          />
        ) : (
          <WorkflowInput
            classNames={{ input: "orca-field-input" }}
            onChange={(event) => updateField(field.key, event.target.value, field.control)}
            type="text"
            value={value}
          />
        )}
      </label>
    );
  }

  if (workspaceView === "setups") return <section aria-label="Orca profile library" style={{ maxWidth: 1200, marginInline: "auto" }}>
    <OrcaConnectionPanel />
    <WorkflowButton className="secondary-action" onClick={() => setWorkspaceView("editor")}>Open preset editor</WorkflowButton>
  </section>;

  return (
    <div className="profile-workspace" style={{ minWidth: 0, width: "100%" }}>
      {/* ── Left sidebar: printer's presets, grouped by type ── */}
      <aside className="profile-sidebar" style={{ minWidth: 0 }}>
        <div className="profile-sidebar-header">
          <h1>{tabLabels.Slicer}</h1>
        </div>

        <input
          accept={ACCEPT}
          aria-label="Import OrcaSlicer presets"
          hidden
          multiple
          onChange={(event) => void handleFiles(event.target.files)}
          ref={fileInputRef}
          type="file"
        />
        <WorkflowButton className="primary-action" onClick={() => fileInputRef.current?.click()} type="button">
          <Upload size={14} />
          <span>Import preset or bundle</span>
        </WorkflowButton>

        <div className="profile-new-row">
          {GROUPS.map((group) => (
            <UnstyledButton className="profile-new-button" key={group.type} onClick={() => startNew(group.type)} style={{ alignItems: "center", background: "transparent", border: "1.5px dashed var(--border)", borderRadius: "var(--radius-sm)", color: "var(--muted-foreground)", cursor: "pointer", display: "flex", flex: "1 1 auto", font: "inherit", gap: 6, padding: "8px 12px", textAlign: "left", width: "100%" }} type="button">
              <Plus size={14} />
              <span>{group.newLabel}</span>
            </UnstyledButton>
          ))}
        </div>

        {importErrors.length > 0 ? (
          <ul className="profile-import-errors" role="alert">
            {importErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}

        {printerAssets.length === 0 ? (
          <p className="profile-list-empty">No editable presets yet. Import a preset or bundle to use this editor. Your saved setups are in the saved setups view.</p>
        ) : (
          grouped.map((group) => (
            <div className="orca-preset-group" key={group.type}>
              <p className="orca-preset-group-heading">
                {group.label}
                <span>{group.items.length}</span>
              </p>
              {group.items.length === 0 ? (
                <p className="orca-preset-group-empty">None yet</p>
              ) : (
                <ul className="profile-list">
                  {group.items.map((asset) => (
                    <li key={asset.id}>
                      <UnstyledButton
                        className={`profile-list-item${asset.id === editingCompanionAssetId ? " is-active" : ""}`}
                        onClick={() => loadCompanionAssetForEdit(asset.id)}
                        style={{ alignItems: "flex-start", background: asset.id === editingCompanionAssetId ? "var(--accent-soft)" : "transparent", border: `1px solid ${asset.id === editingCompanionAssetId ? "var(--primary)" : "transparent"}`, borderRadius: "var(--radius-sm)", color: "var(--foreground)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", textAlign: "left", width: "100%" }}
                        type="button"
                      >
                        <strong>{asset.title}</strong>
                      </UnstyledButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}

        {otherAssets.length > 0 && <div className="orca-preset-group">
          <p className="orca-preset-group-heading">Other saved assets<span>{otherAssets.length}</span></p>
          <p className="orca-preset-group-empty">Open legacy or unrecognised formats to inspect or delete them.</p>
          <ul className="profile-list">{otherAssets.map(asset => <li key={asset.id}>
            <UnstyledButton className={`profile-list-item${asset.id === editingCompanionAssetId ? " is-active" : ""}`}
              onClick={() => loadCompanionAssetForEdit(asset.id)} type="button"><strong>{asset.title}</strong></UnstyledButton>
          </li>)}</ul>
        </div>}
        <p className="profile-status" role="status">{companionAssetStatus}</p>
      </aside>

      {/* ── Right panel: edit form ── */}
      <div className="profile-edit-panel" style={{ minWidth: 0 }}>
        <HelpRow label="Preset editor" help="Edit individual presets here. Imported profile backups and saved setups are separate copies and are not changed by this editor.">
          <WorkflowButton className="secondary-action" onClick={() => setWorkspaceView("setups")}>Back to profile library</WorkflowButton>
        </HelpRow>
        <div className="profile-edit-header">
          <div className="profile-meta-fields">
            <label className="field">
              <span>Preset name</span>
              <WorkflowInput
                onChange={(event) => {
                  updateCompanionAssetDraft("title", event.target.value);
                  updateCompanionAssetDraft("content", withPresetName(companionAssetDraft.content, event.target.value));
                }}
                placeholder="Generic PLA @Voron 2.4"
                value={companionAssetDraft.title}
              />
            </label>
            <label className="field">
              <span>Tags</span>
              <WorkflowInput
                onChange={(event) => updateCompanionAssetDraft("tags", event.target.value)}
                placeholder="pla, generic, 0.4mm"
                value={companionAssetDraft.tags}
              />
            </label>
            <label className="field">
              <span>Description</span>
              <WorkflowTextarea
                classNames={{ input: "plain-textarea" }}
                onChange={(event) => updateCompanionAssetDraft("description", event.target.value)}
                placeholder="Notes about when or how to use this preset."
                value={companionAssetDraft.description}
              />
            </label>
          </div>

          <div className="profile-edit-actions">
            <WorkflowButton className="primary-action" disabled={!canSave || deleting} onClick={saveCompanionAsset} type="button">
              <Save size={16} />
              <span>{isEditing ? "Update preset" : "Save preset"}</span>
            </WorkflowButton>
            {isEditing && editingCompanionAssetId && pendingDeleteId !== editingCompanionAssetId ? (
                <Button ref={deleteButtonRef} className="danger-action" color="red" variant="outline" disabled={deleting} onClick={() => { lastDeleteTarget.current = editingCompanionAssetId; setPendingDeleteId(editingCompanionAssetId); }} type="button">
                  <Trash2 size={16} />
                  <span>Delete</span>
                </Button>
            ) : null}
          </div>
        </div>

        {editingCompanionAssetId && pendingDeleteId === editingCompanionAssetId ? (
          <div aria-label="Confirm delete preset" className="token-revoke-confirm profile-delete-confirm" role="group">
            <strong>Delete “{companionAssets.find(asset => asset.id === editingCompanionAssetId)?.title ?? "this preset"}”?</strong>
            <p>{authUser ? "This removes the saved cloud preset and this browser's copy. Presets attached to a private configuration package must be detached first."
              : "This removes only the local copy. Sign in to remove a saved cloud copy."}</p>
            <p>Published copies and their public configuration links remain available. Printer files are not changed.</p>
            {deleteFailedId === editingCompanionAssetId && <p role="alert">The preset was not deleted. {companionAssetStatus}</p>}
            <div>
              <Button ref={cancelDeleteRef} disabled={deleting} className="inline-action" variant="default" onClick={() => { setPendingDeleteId(""); setDeleteFailedId(""); }} type="button">
                Cancel
              </Button>
              <WorkflowButton
                className="danger-action"
                disabled={deleting}
                onClick={() => void confirmDelete(editingCompanionAssetId)}
                type="button"
              >
                {deleting ? "Deleting…" : "Delete preset"}
              </WorkflowButton>
            </div>
          </div>
        ) : null}

        {model && draftPreset ? (
          <>
            {/* Read-only identity: type, inheritance, ids, version. */}
            {model.identity.length > 0 ? (
              <dl className="orca-identity">
                {model.identity.map((field) => (
                  <div className="orca-identity-item" key={field.key}>
                    <dt>{field.label}</dt>
                    <dd>{getPresetField(draftPreset.json, field.key, field.control) || "—"}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            <div className="orca-toolbar">
              <label className="orca-search">
                <Search aria-hidden size={15} />
                <WorkflowInput
                  aria-label="Search preset settings"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search settings…"
                  style={{ flex: 1, minWidth: 0 }}
                  type="search"
                  value={search}
                />
              </label>
              {query ? <span className="orca-match-count">{matchCount} match{matchCount === 1 ? "" : "es"}</span> : null}
            </div>

            <div className="profile-sections">
              {query ? (
                matchedSections.length === 0 ? (
                  <p className="profile-list-empty">No settings match “{search}”.</p>
                ) : (
                  matchedSections.map((section) => (
                    <section className="orca-section" key={section.caption}>
                      <h3 className="orca-section-heading">{section.caption}</h3>
                      <div className="orca-field-grid">{section.fields.map(renderField)}</div>
                    </section>
                  ))
                )
              ) : tabs.length === 0 ? (
                <p className="profile-list-empty">
                  This preset has no editable settings yet. Add them in the raw JSON below, or import a preset.
                </p>
              ) : (
                <>
                  <Tabs id="orca-preset-tabs" onChange={(value) => value && setActivePresetTab(value)} value={currentTab?.title ?? null}>
                    <Tabs.List aria-label="Preset settings" className="orca-tabs">
                      {tabs.map((tab) => (
                        <Tabs.Tab
                          className={tab.title === currentTab?.title ? "orca-tab is-active" : "orca-tab"}
                          key={tab.title}
                          value={tab.title}
                        >
                          {tab.title}
                        </Tabs.Tab>
                      ))}
                    </Tabs.List>
                  {currentTab ? (
                    <Tabs.Panel value={currentTab.title}>
                      {currentTab.sections.map((section) => (
                        <section className="orca-section" key={section.title || "_general"}>
                          {section.title ? <h3 className="orca-section-heading">{section.title}</h3> : null}
                          <div className="orca-field-grid">{section.fields.map(renderField)}</div>
                        </section>
                      ))}
                    </Tabs.Panel>
                  ) : null}
                  </Tabs>
                </>
              )}
            </div>

            <details className="structured-profile-section" onToggle={(event) => setShowRaw(event.currentTarget.open)} open={showRaw}>
              <summary className="section-heading">
                <h3>
                  <FileJson size={15} /> Raw preset JSON
                </h3>
              </summary>
              <textarea
                aria-label="Raw preset JSON"
                className="code-editor orca-raw-json"
                onChange={(event) => updateCompanionAssetDraft("content", event.target.value)}
                spellCheck={false}
                value={companionAssetDraft.content}
              />
            </details>
          </>
        ) : (
          <div className="profile-empty-editor">
            <p>
              {companionAssetDraft.content.trim()
                ? "This content is not valid OrcaSlicer preset JSON. Fix it in the raw editor below."
                : "Import a preset or start a new one to edit it here."}
            </p>
            {companionAssetDraft.content.trim() ? (
              <textarea
                aria-label="Raw preset JSON"
                className="code-editor orca-raw-json"
                onChange={(event) => updateCompanionAssetDraft("content", event.target.value)}
                spellCheck={false}
                value={companionAssetDraft.content}
              />
            ) : null}
          </div>
        )}

        {/* Package link + share — only for a saved, selected preset */}
        {selectedAsset ? (
          <div className="profile-link-section">
            {selectedPackage ? (
              <div className="profile-link-row">
                <div>
                  <strong>Package link</strong>
                  <span>
                    {linkedIds.has(selectedAsset.id)
                      ? `Linked to ${selectedPackage.title}`
                      : `Link this preset to ${selectedPackage.title}`}
                  </span>
                </div>
                <WorkflowButton
                  className="inline-action"
                  disabled={linkedIds.has(selectedAsset.id)}
                  onClick={linkSelectedCompanionAssetToPackage}
                  type="button"
                >
                  <Share2 size={14} />
                  <span>Link to package</span>
                </WorkflowButton>
              </div>
            ) : null}

            <div className="profile-link-row">
              <div>
                <strong>Share</strong>
                <span>
                  {selectedAsset.publicUrl
                    ? `Published ${selectedAsset.publishedAt ? formatDate(selectedAsset.publishedAt) : ""}`
                    : "Publish only when safe to share publicly."}
                </span>
              </div>
              {selectedAsset.publicUrl ? (
                <a className="inline-action" href={selectedAsset.publicUrl} rel="noreferrer" target="_blank">
                  <Share2 size={14} />
                  <span>Open public link</span>
                </a>
              ) : (
                <WorkflowButton className="inline-action" disabled={deleting || !draftPreset} onClick={publishSelectedCompanionAsset} type="button">
                  <Share2 size={14} />
                  <span>Publish preset</span>
                </WorkflowButton>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
