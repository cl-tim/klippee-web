type PublishReadinessInput = {
  approvalStatusHasUnpublishedAppliedVersion: boolean;
  candidateLoadFailed: boolean;
  candidateLoading: boolean;
  hasPublicListing: boolean;
  listingTitle: string;
  publicationCandidate: {
    fileCount: number;
    repositoryId: string;
    versionNumber: number;
  } | null;
  selectedPrinterRepositoryId: string | null;
  workspacePublishBlocks: number;
  workspacePublishable: boolean;
};

export type PublishReadiness = {
  canPublish: boolean;
  message: string;
};

/**
 * Pure derivation of the registry publisher's footer state: whether the
 * applied publication candidate can be published right now, and the one-line
 * explanation shown to the user. Replaces the nested-ternary chain that used
 * to live inline in RegistryPublisherModal.
 */
export function derivePublishReadiness({
  approvalStatusHasUnpublishedAppliedVersion,
  candidateLoadFailed,
  candidateLoading,
  hasPublicListing,
  listingTitle,
  publicationCandidate,
  selectedPrinterRepositoryId,
  workspacePublishBlocks,
  workspacePublishable,
}: PublishReadinessInput): PublishReadiness {
  if (!workspacePublishable) {
    return { canPublish: false, message: "Sign in to publish this printer's applied configuration." };
  }
  if (!selectedPrinterRepositoryId) {
    return { canPublish: false, message: "Create a cloud configuration before publishing." };
  }
  if (candidateLoading) {
    return { canPublish: false, message: "Loading the exact configuration currently applied to this printer." };
  }
  if (candidateLoadFailed) {
    return { canPublish: false, message: "The applied configuration could not be loaded. Retry before publishing." };
  }
  if (!publicationCandidate) {
    return { canPublish: false, message: "Apply a configuration on this printer before publishing." };
  }
  if (publicationCandidate.repositoryId !== selectedPrinterRepositoryId) {
    return { canPublish: false, message: "The applied configuration belongs to a different repository. Refresh before publishing." };
  }
  if (!publicationCandidate.fileCount) {
    return { canPublish: false, message: "The applied configuration has no files to publish." };
  }
  if (!listingTitle.trim()) {
    return { canPublish: false, message: "Add a listing title before publishing." };
  }
  if (workspacePublishBlocks > 0) {
    return { canPublish: false, message: "Resolve blocking findings in the applied configuration before publishing." };
  }
  if (hasPublicListing && approvalStatusHasUnpublishedAppliedVersion) {
    return { canPublish: true, message: "A newer applied configuration is ready for your review and approval." };
  }
  return {
    canPublish: true,
    message: `Applied version ${publicationCandidate.versionNumber} is ready to ${hasPublicListing ? "approve and republish" : "publish"}.`,
  };
}
