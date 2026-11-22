import { WorkflowButton, WorkflowInput, WorkflowTextarea } from "./WorkflowControls";
import { ArrowLeft, CheckCircle2, Copy, FileCode2, Pencil, Save, X } from "lucide-react";
import { Badge, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useState } from "react";
import { formatBytes } from "../../app/format";
import type { PackageDraft, PublicPackageApprovalStatus } from "../../app/types";
import { RiskWarning } from "../../components/common";
import { HelpRow } from "../../components/FieldHelp";
import { TagInput } from "../../components/TagInput";
import { useCopyFeedback } from "../../lib/useCopyFeedback";
import type { ConfigFile, ConfigPackage } from "../../types";
import { ConfigSourceCode } from "./configHighlighting";
import { listingDraftFor, uniqueSuggestions } from "./listingDraft";
import { LinkedOrcaProfiles } from "../orca/LinkedOrcaProfiles";

/**
 * Public package detail screen: published files, read-only source preview,
 * listing metadata, and (for owners) the listing editor. Render it with
 * `key={pkg.id}` so per-package state (selected file, listing draft) resets
 * when the route moves between two package pages.
 */
export function PublicConfigWorkspace({
  approvalStatus,
  availablePackages,
  canEdit,
  onBack,
  onConfigure,
  onUpdateListing,
  pkg,
  publishStatus,
}: {
  approvalStatus: PublicPackageApprovalStatus | null;
  availablePackages: ConfigPackage[];
  canEdit: boolean;
  onBack: () => void;
  onConfigure: () => void;
  onUpdateListing: (draft: PackageDraft) => Promise<boolean>;
  pkg: ConfigPackage;
  publishStatus: string;
}) {
  const publicFiles = pkg.files.filter((file) => file.public !== false);
  const [selectedPath, setSelectedPath] = useState(publicFiles[0]?.path ?? "");
  const selectedFile = publicFiles.find((file) => file.path === selectedPath) ?? publicFiles[0] ?? null;
  const contentsLoading = publicFiles.length > 0 && publicFiles.every((file) => file.content === "");
  const { copied: shareLinkCopied, copy: copyToClipboard } = useCopyFeedback();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [listingDraft, setListingDraft] = useState<PackageDraft>(() => listingDraftFor(pkg));
  const stackWorkspacePanels = useMediaQuery("(max-width: 1180px)", false, { getInitialValueInEffect: false });
  const shareUrl =
    typeof window === "undefined"
      ? `/packages/${encodeURIComponent(pkg.publicSlug ?? pkg.id)}`
      : `${window.location.origin}/packages/${encodeURIComponent(pkg.publicSlug ?? pkg.id)}`;
  const printerSuggestions = uniqueSuggestions(availablePackages.map((candidate) => candidate.printer));
  const hardwareSuggestions = uniqueSuggestions(availablePackages.flatMap((candidate) => candidate.hardware));
  const tagSuggestions = uniqueSuggestions(
    availablePackages.flatMap((candidate) => candidate.tags.filter((tag) => tag !== "private" && tag !== "public")),
  );

  function copyShareLink() {
    void copyToClipboard(shareUrl);
  }

  function beginEditing() {
    setListingDraft(listingDraftFor(pkg));
    setEditing(true);
  }

  function updateDraft(field: keyof PackageDraft, value: string) {
    setListingDraft((current) => ({ ...current, [field]: value }));
  }

  async function saveListing() {
    if (!listingDraft.title.trim()) return;
    setSaving(true);
    const updated = await onUpdateListing(listingDraft);
    setSaving(false);
    if (updated) setEditing(false);
  }

  return (
    <section
      aria-labelledby="public-config-title"
      className="public-config-workspace"
      style={stackWorkspacePanels ? { flex: "none", overflow: "visible" } : undefined}
    >
      <header className="public-config-workspace-header">
        <div className="public-config-heading">
          <WorkflowButton className="inline-action public-config-back" onClick={onBack} type="button">
            <ArrowLeft size={16} />
            <span>Shared Configs</span>
          </WorkflowButton>
          <div>
            <h2 id="public-config-title">{pkg.title}</h2>
          </div>
        </div>
        <div
          className="public-config-actions"
          style={stackWorkspacePanels ? { flex: "0 1 auto", maxWidth: "100%", minWidth: 0, width: "100%" } : undefined}
        >
          <WorkflowButton className="inline-action" onClick={copyShareLink} type="button">
            <Copy size={16} />
            <span>{shareLinkCopied ? "Copied" : "Copy link"}</span>
          </WorkflowButton>
          {canEdit ? (
            <WorkflowButton className="inline-action" onClick={beginEditing} type="button">
              <Pencil size={16} />
              <span>Edit listing</span>
            </WorkflowButton>
          ) : null}
          <WorkflowButton className="primary-action" onClick={onConfigure} style={{ flex: "0 1 max-content", maxWidth: "100%" }} type="button">
            <CheckCircle2 size={18} />
            <span>Configure for a printer</span>
          </WorkflowButton>
        </div>
      </header>

      {canEdit && approvalStatus?.linked && (!approvalStatus.autoUpdateEnabled || approvalStatus.hasUnpublishedAppliedVersion) ? (
        <RiskWarning
          title={approvalStatus.hasUnpublishedAppliedVersion
            ? "A newer applied configuration is still private"
            : "Future printer applies stay private"}
          warnings={[
            approvalStatus.hasUnpublishedAppliedVersion
              ? approvalStatus.autoUpdateError ?? "The printer has applied a newer version, but public downloads still use the last published files. Review and republish it or enable automatic updates from this printer's workspace."
              : "This listing changes only when you explicitly approve and republish from the printer workspace.",
          ]}
        />
      ) : null}

      {canEdit && approvalStatus?.autoUpdateEnabled ? (
        <p role="status">Automatic updates to Shared Configs are enabled for this printer. Draft edits stay private.</p>
      ) : null}

      {editing ? (
        <ListingEditor
          draft={listingDraft}
          hardwareSuggestions={hardwareSuggestions}
          onCancel={() => setEditing(false)}
          onSave={() => void saveListing()}
          onUpdate={updateDraft}
          printerSuggestions={printerSuggestions}
          saving={saving}
          status={publishStatus}
          tagSuggestions={tagSuggestions}
          linked={Boolean(approvalStatus?.linked)}
        />
      ) : null}

      <div
        className="public-config-workspace-body"
        style={stackWorkspacePanels ? { flex: "none", minHeight: "auto", gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "auto minmax(480px, auto) auto" } : undefined}
      >
        <aside
          className="public-config-file-panel"
          style={stackWorkspacePanels ? { maxHeight: 220, borderRight: 0, borderBottom: "1px solid var(--border)" } : undefined}
        >
          <header>
            <div>
              <strong>Configuration Files</strong>
            </div>
            <span>{publicFiles.length}</span>
          </header>
          {publicFiles.length ? (
            <nav aria-label="Configuration files" className="public-config-file-list">
              {publicFiles.map((file) => (
                <ConfigFileButton
                  file={file}
                  key={file.path}
                  onSelect={() => setSelectedPath(file.path)}
                  selected={file.path === selectedFile?.path}
                />
              ))}
            </nav>
          ) : (
            <div className="empty-state">No public files in this listing.</div>
          )}
        </aside>

        <article
          aria-label={selectedFile ? `Preview ${selectedFile.path}` : "Configuration file preview"}
          className="public-config-editor"
        >
          {selectedFile ? (
            <>
              <header>
                <div>
                  <FileCode2 aria-hidden="true" size={16} />
                  <strong>{selectedFile.path}</strong>
                  <span>Read-only</span>
                </div>
                <span>{selectedFile.role || "config"} · {formatBytes(new TextEncoder().encode(selectedFile.content).byteLength)}</span>
              </header>
              {contentsLoading ? (
                <div className="package-config-preview-state" role="status">Loading configuration files…</div>
              ) : selectedFile.content ? (
                <ConfigSourceCode content={selectedFile.content} path={selectedFile.path} />
              ) : (
                <div className="package-config-preview-state">This file is empty.</div>
              )}
            </>
          ) : null}
        </article>

        <aside
          className="public-config-info-panel"
          style={stackWorkspacePanels ? { gridColumn: 1, display: "flex", minHeight: "auto", overflowY: "visible", borderLeft: 0 } : undefined}
        >
          <section>
            <h3>Package details</h3>
            {pkg.description ? <p>{pkg.description}</p> : null}
            <dl className="public-config-meta">
              <div>
                <dt>{pkg.tracksAppliedConfiguration ? "Publication" : "Version"}</dt>
                <dd>{pkg.tracksAppliedConfiguration ? "Shows the printer configuration last approved by its owner" : pkg.version}</dd>
              </div>
              <div><dt>Printer</dt><dd>{pkg.printer || "Unspecified"}</dd></div>
              <div><dt>Hardware</dt><dd>{pkg.hardware.join(", ") || "—"}</dd></div>
              <div><dt>Variables</dt><dd>{pkg.variables.length}</dd></div>
            </dl>
          </section>
          <LinkedOrcaProfiles configSlug={pkg.publicSlug ?? pkg.id} />
          {pkg.tags.length ? (
            <section>
              <h3>Tags</h3>
              <div className="tag-row">
                {pkg.tags.map((tag) => <Badge key={tag} variant="light">{tag}</Badge>)}
              </div>
            </section>
          ) : null}
          <RiskWarning
            title="Review before use"
            warnings={["Community configurations are not tested or endorsed by Klippee. Verify pins, heaters, limits, and macros for your hardware."]}
          />
          <section className="public-config-share">
            <h3>Share</h3>
            <code>{shareUrl}</code>
            <WorkflowButton className="inline-action" onClick={copyShareLink} type="button">
              <Copy size={15} />
              <span>{shareLinkCopied ? "Copied" : "Copy public link"}</span>
            </WorkflowButton>
          </section>
        </aside>
      </div>
    </section>
  );
}

function ListingEditor({
  draft,
  hardwareSuggestions,
  linked,
  onCancel,
  onSave,
  onUpdate,
  printerSuggestions,
  saving,
  status,
  tagSuggestions,
}: {
  draft: PackageDraft;
  hardwareSuggestions: string[];
  linked: boolean;
  onCancel: () => void;
  onSave: () => void;
  onUpdate: (field: keyof PackageDraft, value: string) => void;
  printerSuggestions: string[];
  saving: boolean;
  status: string;
  tagSuggestions: string[];
}) {
  return (
    <section aria-label="Edit public listing" className="public-config-listing-editor">
      <header>
        <div>
          <HelpRow label="Edit public listing" help={linked
              ? "Update its Shared Configs listing. Saving does not approve or change the public configuration files."
              : "Update how this configuration appears in Shared Configs. Its files and version stay unchanged."}>
            <strong>Edit public listing</strong>
          </HelpRow>
        </div>
        <WorkflowButton aria-label="Cancel listing edit" className="icon-button" onClick={onCancel} type="button"><X size={16} /></WorkflowButton>
      </header>
      <div className="public-config-listing-fields">
        <label className="field" htmlFor="public-listing-title">
          <span>Listing title</span>
          <WorkflowInput id="public-listing-title" onChange={(event) => onUpdate("title", event.target.value)} value={draft.title} />
        </label>
        <label className="field public-config-listing-description" htmlFor="public-listing-description">
          <span>Description</span>
          <WorkflowTextarea classNames={{ input: "plain-textarea" }} id="public-listing-description" onChange={(event) => onUpdate("description", event.target.value)} value={draft.description} />
        </label>
        <TagInput id="public-listing-printer" label="Printer model" onChange={(value) => onUpdate("printer", value)} placeholder="Printer or model" suggestions={printerSuggestions} value={draft.printer} />
        <TagInput id="public-listing-hardware" label="Hardware" onChange={(value) => onUpdate("hardware", value)} placeholder="Klipper, Beacon, CAN bus" suggestions={hardwareSuggestions} value={draft.hardware} />
        <TagInput id="public-listing-tags" label="Search tags" onChange={(value) => onUpdate("tags", value)} placeholder="corexy, beacon" suggestions={tagSuggestions} value={draft.tags} />
      </div>
      <footer>
        <span>{status}</span>
        <WorkflowButton className="primary-action" disabled={saving || !draft.title.trim()} onClick={onSave} type="button">
          <Save size={16} />
          <span>{saving ? "Saving…" : "Save listing"}</span>
        </WorkflowButton>
      </footer>
    </section>
  );
}

function ConfigFileButton({
  file,
  onSelect,
  selected,
}: {
  file: ConfigFile;
  onSelect: () => void;
  selected: boolean;
}) {
  const separatorIndex = file.path.lastIndexOf("/");
  const directory = separatorIndex >= 0 ? file.path.slice(0, separatorIndex + 1) : "";
  const name = separatorIndex >= 0 ? file.path.slice(separatorIndex + 1) : file.path;
  return (
    <UnstyledButton aria-pressed={selected} className={selected ? "is-selected" : ""} onClick={onSelect} style={{ alignItems: "center", background: selected ? "var(--accent-soft)" : "transparent", border: `1px solid ${selected ? "var(--primary)" : "transparent"}`, borderRadius: "var(--radius-sm)", color: "var(--foreground)", cursor: "pointer", display: "flex", gap: 10, minHeight: 44, padding: "8px 10px", textAlign: "left", width: "100%" }} type="button">
      <FileCode2 aria-hidden="true" size={15} />
      <span>
        {directory ? <small>{directory}</small> : null}
        <strong>{name}</strong>
      </span>
    </UnstyledButton>
  );
}
