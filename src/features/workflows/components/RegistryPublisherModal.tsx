import { WorkflowButton, WorkflowInput, WorkflowTextarea } from "../WorkflowControls";
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, ExternalLink, FileCode2, Send } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { usePackageContext } from "../../../app/contexts/usePackageContext";
import { usePrinterContext } from "../../../app/contexts/usePrinterContext";
import { formatDate } from "../../../app/format";
import { usePrinterPublicationCandidate } from "../../../app/hooks/usePrinterPublicationCandidate";
import { usePublicPackageApprovalStatus } from "../../../app/hooks/usePublicPackageApprovalStatus";
import { ModalShell } from "../../../components/ModalShell";
import { TagInput } from "../../../components/TagInput";
import { useCopyFeedback } from "../../../lib/useCopyFeedback";
import { variablesFromFiles } from "../../../packageBuilder";
import { scanPublicConfigFiles } from "../../../safety";
import { listingDraftFor, uniqueSuggestions } from "../listingDraft";
import { derivePublishReadiness } from "../publishReadiness";
import { RegistryAutoUpdateSettings } from "./RegistryAutoUpdateSettings";

const commonPrinterModels = [
  "QIDI Plus 4",
  "Voron 2.4",
  "Voron Trident",
  "RatRig V-Core 3",
  "Ender 3",
  "Generic CoreXY",
  "Generic Cartesian",
];

const commonHardware = [
  "Klipper",
  "Beacon",
  "Cartographer",
  "Eddy",
  "CAN bus",
  "ADXL345",
  "EBB36",
  "EBB42",
  "CoreXY",
  "Raspberry Pi",
];

const commonSearchTags = [
  "klipper",
  "corexy",
  "cartesian",
  "bedslinger",
  "input-shaping",
  "beacon",
  "canbus",
  "kamp",
  "macros",
  "qidi",
  "voron",
];

export function RegistryPublisherModal({
  onClose,
  open,
}: {
  onClose: () => void;
  open: boolean;
}) {
  const { selectedPrinter } = usePrinterContext();
  const {
    availablePackages,
    buildStatus,
    packageDraft,
    privatePackages,
    publishStatus,
    publishWorkspacePackage,
    workspacePublishable,
  } = usePackageContext();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingPublicConfirmation, setPendingPublicConfirmation] = useState<string | null>(null);
  const [publishingCandidateVersionId, setPublishingCandidateVersionId] = useState<string | null>(null);
  const { copied: shareLinkCopied, copy: copyToClipboard } = useCopyFeedback();
  const [listingDraftOverrides, setListingDraftOverrides] = useState<Record<string, Partial<typeof packageDraft>>>({});

  const deterministicWorkspacePackageId = selectedPrinter ? `printer-${selectedPrinter.id}-workspace` : "";
  const workspacePrivatePackage = privatePackages.find(
    (candidate) => candidate.id === deterministicWorkspacePackageId,
  ) ?? privatePackages.find(
    (candidate) => selectedPrinter?.packageIds.includes(candidate.id),
  );
  const workspacePackageId = workspacePrivatePackage?.id ?? deterministicWorkspacePackageId;
  const baseListingDraft = workspacePrivatePackage
    ? listingDraftFor(workspacePrivatePackage)
    : {
        ...packageDraft,
        printer: packageDraft.printer || selectedPrinter?.name || "",
        tags: packageDraft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag && tag !== "private" && tag !== "public")
          .join(", "),
      };
  const listingDraft = {
    ...baseListingDraft,
    ...listingDraftOverrides[workspacePackageId],
  };
  const publicListing = availablePackages.find(
    (candidate) => candidate.sourcePackageId === workspacePackageId,
  );
  const publicListingId = publicListing?.publicSlug ?? publicListing?.id ?? null;
  const {
    refresh: refreshApprovalStatus,
    loading: approvalStatusLoading,
    failed: approvalStatusFailed,
    autoUpdateSaveError,
    savingAutoUpdate,
    setAutoUpdate,
    status: approvalStatus,
  } = usePublicPackageApprovalStatus(publicListingId, open && Boolean(publicListing));
  const {
    candidate: publicationCandidate,
    failed: candidateLoadFailed,
    loading: candidateLoading,
    refresh: refreshPublicationCandidate,
  } = usePrinterPublicationCandidate(
    selectedPrinter?.id ?? null,
    open && Boolean(selectedPrinter?.repositoryId),
  );
  const closePublisher = useCallback(() => {
    setPendingPublicConfirmation(null);
    refreshPublicationCandidate();
    refreshApprovalStatus();
    onClose();
  }, [onClose, refreshApprovalStatus, refreshPublicationCandidate]);
  const workspacePublishFindings = useMemo(
    () => scanPublicConfigFiles(publicationCandidate?.files ?? []),
    [publicationCandidate],
  );
  const publicationVariables = useMemo(
    () => variablesFromFiles(publicationCandidate?.files ?? [], []),
    [publicationCandidate],
  );
  const workspacePublishWarnings = workspacePublishFindings.filter(
    (finding) => finding.severity === "warn",
  ).length;
  const workspacePublishBlocks = workspacePublishFindings.filter(
    (finding) => finding.severity === "block",
  ).length;
  const publishReadiness = derivePublishReadiness({
    approvalStatusHasUnpublishedAppliedVersion: Boolean(approvalStatus?.hasUnpublishedAppliedVersion),
    candidateLoadFailed,
    candidateLoading,
    hasPublicListing: Boolean(publicListing),
    listingTitle: listingDraft.title,
    publicationCandidate: publicationCandidate
      ? {
          fileCount: publicationCandidate.files.length,
          repositoryId: publicationCandidate.repositoryId,
          versionNumber: publicationCandidate.versionNumber,
        }
      : null,
    selectedPrinterRepositoryId: selectedPrinter?.repositoryId ?? null,
    workspacePublishBlocks,
    workspacePublishable,
  });
  const listingChanged = Object.entries(listingDraft).some(
    ([field, value]) => value !== baseListingDraft[field as keyof typeof baseListingDraft],
  );
  const listingCurrent = Boolean(publicListing && !approvalStatusLoading && !approvalStatusFailed && approvalStatus?.linked
    && !approvalStatus.hasUnpublishedAppliedVersion
    && approvalStatus.approvedVersionId === publicationCandidate?.versionId);
  const automaticUpdatePaused = Boolean(approvalStatus?.autoUpdateEnabled && approvalStatus.autoUpdateError);
  const needsPublication = !listingCurrent || listingChanged;
  const publicationDisabled = !publishReadiness.canPublish || approvalStatusLoading
    || approvalStatusFailed || Boolean(publishingCandidateVersionId);
  const statusTitle = approvalStatusLoading ? "Checking publication status..."
    : approvalStatusFailed ? "Publication status unavailable"
    : candidateLoading ? "Checking applied configuration..."
    : candidateLoadFailed ? "Applied configuration unavailable"
    : !publicationCandidate ? "No applied candidate"
    : automaticUpdatePaused ? "Automatic updates paused"
    : !publishReadiness.canPublish ? "Not ready to publish"
    : listingChanged ? "Listing changes to publish"
    : listingCurrent ? "Public listing is up to date"
    : publicListing ? "Applied update ready to publish"
    : "Ready for first publication";
  const statusMessage = approvalStatusLoading ? "Checking which applied version is public."
    : approvalStatusFailed ? "The public listing status could not be checked. Retry before publishing."
    : candidateLoading || !publishReadiness.canPublish ? publishReadiness.message
    : automaticUpdatePaused ? approvalStatus?.autoUpdateError
    : listingChanged ? "Publish to save your listing details with the applied configuration."
    : listingCurrent ? `Applied version ${publicationCandidate?.versionNumber} is public.`
    : publicListing ? "The latest applied configuration is still private. Review it before publishing."
    : "Published files and listing details will be available to anyone.";
  const publicListingUrl = publicListing
    ? `${window.location.origin}/packages/${encodeURIComponent(publicListing.publicSlug ?? publicListing.id)}`
    : "";
  const knownPackages = [...privatePackages, ...availablePackages];
  const printerSuggestions = uniqueSuggestions([
    selectedPrinter?.model,
    selectedPrinter?.name,
    ...knownPackages.map((candidate) => candidate.printer),
    ...commonPrinterModels,
  ]);
  const hardwareSuggestions = uniqueSuggestions([
    ...commonHardware,
    ...knownPackages.flatMap((candidate) => candidate.hardware),
  ]);
  const tagSuggestions = uniqueSuggestions([
    ...knownPackages.flatMap((candidate) => candidate.tags.filter((tag) => tag !== "private" && tag !== "public")),
    ...commonSearchTags,
  ]);

  function updateListingDraft(field: keyof typeof listingDraft, value: string) {
    setListingDraftOverrides((current) => ({
      ...current,
      [workspacePackageId]: {
        ...current[workspacePackageId],
        [field]: value,
      },
    }));
  }

  async function publishWorkspace(acknowledgeSafetyWarnings: boolean) {
    if (!publicationCandidate || publishingCandidateVersionId) return;
    const reviewedCandidate = publicationCandidate;
    setPublishingCandidateVersionId(reviewedCandidate.versionId);
    try {
      await publishWorkspacePackage(
        listingDraft,
        reviewedCandidate,
        acknowledgeSafetyWarnings,
      );
    } finally {
      setPendingPublicConfirmation(null);
      setPublishingCandidateVersionId(null);
      refreshPublicationCandidate();
      refreshApprovalStatus();
    }
  }

  function requestPackagePublication() {
    if (!publicationCandidate) return;
    if (workspacePublishWarnings) {
      setReviewOpen(true);
      setPendingPublicConfirmation(publicationCandidate.versionId);
      return;
    }
    void publishWorkspace(false);
  }

  function copyShareLink() {
    if (!publicListingUrl) return;
    void copyToClipboard(publicListingUrl);
  }

  return (
    <ModalShell
      closeLabel="Close Shared Configs publisher"
      onClose={closePublisher}
      open={open}
      sizeClass="registry-publisher-modal"
      title={`Publish ${selectedPrinter?.name ?? "printer configuration"}`}
    >
      <div className="registry-publish-card">
        <section aria-label="Publication status" className={`registry-publish-status${automaticUpdatePaused || workspacePublishBlocks ? " needs-review" : ""}`}>
          <div className="registry-publish-status-heading">
            {automaticUpdatePaused || workspacePublishBlocks
              ? <AlertTriangle aria-hidden="true" size={22} />
              : listingCurrent ? <CheckCircle2 aria-hidden="true" size={22} /> : <Send aria-hidden="true" size={22} />}
            <h3>{statusTitle}</h3>
          </div>
          <p role="status">{statusMessage}</p>
          {publicListingUrl ? (
            <div className="registry-publish-link">
              <a href={publicListingUrl} rel="noreferrer" target="_blank">
                View public listing <ExternalLink aria-hidden="true" size={14} />
              </a>
              <WorkflowButton aria-label="Copy public package link" className="icon-button" onClick={copyShareLink} title="Copy link" type="button"><Copy size={15} /></WorkflowButton>
              {shareLinkCopied ? <small role="status">Copied</small> : null}
            </div>
          ) : null}
          {((!publicationCandidate && !candidateLoading) || approvalStatusFailed) && selectedPrinter?.repositoryId ? (
            <WorkflowButton className="inline-action" onClick={() => { refreshPublicationCandidate(); refreshApprovalStatus(); }} type="button">
              {candidateLoadFailed || approvalStatusFailed ? "Retry" : "Refresh"}
            </WorkflowButton>
          ) : null}
        </section>

        {publicListingId ? <RegistryAutoUpdateSettings packageId={publicListingId} showPublicationProblem={false} /> : null}
        <p className="registry-publish-privacy">Only printer-applied configurations are published. Draft edits stay private.</p>

        {publicationCandidate ? (
          <>
            {workspacePublishFindings.length ? (
              <details className="registry-publish-disclosure registry-publish-safety" open={reviewOpen || workspacePublishBlocks > 0 || automaticUpdatePaused}
                onToggle={(event) => setReviewOpen(event.currentTarget.open)}>
                <summary><AlertTriangle aria-hidden="true" size={17} /><strong>Safety review</strong><span>{workspacePublishBlocks ? `${workspacePublishBlocks} blocking - ` : ""}{workspacePublishWarnings} warning{workspacePublishWarnings === 1 ? "" : "s"}</span><ChevronDown aria-hidden="true" size={16} /></summary>
                <ul aria-label="Applied candidate safety findings" className="registry-publication-findings">
                  {workspacePublishFindings.map((finding, index) => (
                    <li key={`${finding.path}-${finding.line ?? 0}-${index}`}>
                      <strong>{finding.severity === "block" ? "Blocked" : "Review"}</strong>
                      <span>{finding.path}{finding.line ? `:${finding.line}` : ""} - {finding.message}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <details className="registry-publish-disclosure">
              <summary><FileCode2 aria-hidden="true" size={17} /><strong>Applied configuration</strong><span>Version {publicationCandidate.versionNumber} - {publicationCandidate.files.length} files</span><ChevronDown aria-hidden="true" size={16} /></summary>
              <section aria-label={`Applied publication candidate version ${publicationCandidate.versionNumber}`} className="registry-publication-candidate">
                <p>Applied version {publicationCandidate.versionNumber}{publicationCandidate.appliedAt ? ` - ${formatDate(publicationCandidate.appliedAt)}` : ""} - {publicationVariables.length} variable{publicationVariables.length === 1 ? "" : "s"}</p>
                <div className="registry-publication-candidate-files">
                  {publicationCandidate.files.map((file) => (
                    <details key={file.path}>
                      <summary><FileCode2 aria-hidden="true" size={15} /><strong>{file.path}</strong><span>{file.role || "config"}</span></summary>
                      <pre aria-label={`Applied candidate source for ${file.path}`}><code>{file.content}</code></pre>
                    </details>
                  ))}
                </div>
                {!workspacePublishFindings.length ? <span className="registry-publication-clear">No safety findings.</span> : null}
              </section>
            </details>
          </>
        ) : null}

        <details className="registry-publish-disclosure" open={!listingDraft.title.trim() || undefined}>
          <summary><strong>Listing details</strong><span>{listingDraft.title || "Add a title"}</span><ChevronDown aria-hidden="true" size={16} /></summary>
          <div className="registry-publish-fields">
            <label className="field" htmlFor="workspace-package-title">
              <span>Listing title</span>
              <WorkflowInput id="workspace-package-title" onChange={(event) => updateListingDraft("title", event.target.value)} placeholder={`${selectedPrinter?.name ?? "Printer"} configuration`} value={listingDraft.title} />
            </label>
            <label className="field registry-publish-description" htmlFor="workspace-package-description">
              <span>Description</span>
              <WorkflowTextarea classNames={{ input: "plain-textarea" }} id="workspace-package-description" onChange={(event) => updateListingDraft("description", event.target.value)} placeholder="What this configuration supports and what users should review" value={listingDraft.description} />
            </label>
            <TagInput
              id="workspace-package-printer"
              label="Printer model"
              onChange={(value) => updateListingDraft("printer", value)}
              placeholder={selectedPrinter?.name ?? "Printer or model"}
              suggestions={printerSuggestions}
              value={listingDraft.printer}
            />
            <TagInput
              id="workspace-package-hardware"
              label="Hardware"
              onChange={(value) => updateListingDraft("hardware", value)}
              placeholder="Klipper, Beacon, CAN bus"
              suggestions={hardwareSuggestions}
              value={listingDraft.hardware}
            />
            <TagInput
              className="registry-publish-tags"
              id="workspace-package-tags"
              label="Search tags"
              onChange={(value) => updateListingDraft("tags", value)}
              placeholder="corexy, beacon"
              suggestions={tagSuggestions}
              value={listingDraft.tags}
            />
          </div>

        </details>

          {publicationCandidate && pendingPublicConfirmation === publicationCandidate.versionId ? (
            <div
              aria-label={`Confirm public publication of ${listingDraft.title}`}
              className="package-publish-confirmation"
              role="group"
            >
              <AlertTriangle size={18} />
              <div>
                <strong>{publicListing ? "Approve and republish the applied configuration?" : "Publish this applied configuration for anyone to open?"}</strong>
                <span>
                  Review the applied snapshot above for secrets and machine-specific values first.
                  {publicListing
                    ? " This replaces the public files with the configuration currently applied to this printer."
                    : " Published files and metadata are available without signing in."}
                </span>
                <small>
                  {workspacePublishWarnings} safety warning{workspacePublishWarnings === 1 ? "" : "s"} will remain visible on the listing.
                </small>
              </div>
              <div>
                <WorkflowButton className="inline-action" onClick={() => setPendingPublicConfirmation(null)} type="button">Cancel</WorkflowButton>
                <WorkflowButton
                  className="danger-action"
                  disabled={publicationDisabled}
                  onClick={() => void publishWorkspace(true)}
                  type="button"
                >
                  {publicListing ? "Approve and republish" : "Publish publicly"}
                </WorkflowButton>
              </div>
            </div>
          ) : null}

        <footer className="registry-publish-footer">
          {autoUpdateSaveError ? <p role="alert">{autoUpdateSaveError}</p> : null}
          {publishStatus || buildStatus ? <p role="status">{publishStatus || buildStatus}</p> : null}
          <div className="registry-publish-actions">
            {automaticUpdatePaused ? (
              <WorkflowButton className="inline-action" disabled={savingAutoUpdate} onClick={() => setAutoUpdate(true)} type="button">
                {savingAutoUpdate ? "Retrying..." : "Retry automatic update"}
              </WorkflowButton>
            ) : null}
            {pendingPublicConfirmation !== publicationCandidate?.versionId ? (
              <WorkflowButton
                className={needsPublication ? "primary-action" : "inline-action"}
                disabled={publicationDisabled}
                onClick={requestPackagePublication}
                title={workspacePublishBlocks ? "Resolve blocking safety findings before publishing" : undefined}
                type="button"
              >
                {needsPublication ? <Send aria-hidden="true" size={16} /> : null}
                <span>{publishingCandidateVersionId ? "Publishing..." : !publicListing ? "Publish to Shared Configs" : listingChanged ? "Publish listing changes" : listingCurrent ? "Republish applied version" : "Approve and republish"}</span>
              </WorkflowButton>
            ) : null}
          </div>
        </footer>
      </div>
    </ModalShell>
  );
}
