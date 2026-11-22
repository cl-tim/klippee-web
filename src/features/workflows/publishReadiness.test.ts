import { describe, expect, it } from "vitest";
import { derivePublishReadiness } from "./publishReadiness";

const readyInput = {
  approvalStatusHasUnpublishedAppliedVersion: false,
  candidateLoadFailed: false,
  candidateLoading: false,
  hasPublicListing: false,
  listingTitle: "Voron 2.4 config",
  publicationCandidate: {
    fileCount: 3,
    repositoryId: "repo-1",
    versionNumber: 7,
  },
  selectedPrinterRepositoryId: "repo-1",
  workspacePublishBlocks: 0,
  workspacePublishable: true,
};

describe("derivePublishReadiness", () => {
  it("requires sign-in before anything else", () => {
    expect(derivePublishReadiness({ ...readyInput, workspacePublishable: false })).toEqual({
      canPublish: false,
      message: "Sign in to publish this printer's applied configuration.",
    });
  });

  it("requires a cloud repository", () => {
    expect(derivePublishReadiness({ ...readyInput, selectedPrinterRepositoryId: null })).toEqual({
      canPublish: false,
      message: "Create a cloud configuration before publishing.",
    });
  });

  it("reports a loading candidate", () => {
    expect(derivePublishReadiness({ ...readyInput, candidateLoading: true })).toEqual({
      canPublish: false,
      message: "Loading the exact configuration currently applied to this printer.",
    });
  });

  it("reports a failed candidate load ahead of the missing-candidate state", () => {
    expect(derivePublishReadiness({
      ...readyInput,
      candidateLoadFailed: true,
      publicationCandidate: null,
    })).toEqual({
      canPublish: false,
      message: "The applied configuration could not be loaded. Retry before publishing.",
    });
  });

  it("requires an applied candidate", () => {
    expect(derivePublishReadiness({ ...readyInput, publicationCandidate: null })).toEqual({
      canPublish: false,
      message: "Apply a configuration on this printer before publishing.",
    });
  });

  it("rejects a candidate from a different repository", () => {
    expect(derivePublishReadiness({
      ...readyInput,
      publicationCandidate: { ...readyInput.publicationCandidate, repositoryId: "repo-2" },
    })).toEqual({
      canPublish: false,
      message: "The applied configuration belongs to a different repository. Refresh before publishing.",
    });
  });

  it("rejects a candidate with no files", () => {
    expect(derivePublishReadiness({
      ...readyInput,
      publicationCandidate: { ...readyInput.publicationCandidate, fileCount: 0 },
    })).toEqual({
      canPublish: false,
      message: "The applied configuration has no files to publish.",
    });
  });

  it("requires a non-blank listing title", () => {
    expect(derivePublishReadiness({ ...readyInput, listingTitle: "   " })).toEqual({
      canPublish: false,
      message: "Add a listing title before publishing.",
    });
  });

  it("blocks on blocking safety findings", () => {
    expect(derivePublishReadiness({ ...readyInput, workspacePublishBlocks: 2 })).toEqual({
      canPublish: false,
      message: "Resolve blocking findings in the applied configuration before publishing.",
    });
  });

  it("invites review when a published listing has a newer applied version", () => {
    expect(derivePublishReadiness({
      ...readyInput,
      approvalStatusHasUnpublishedAppliedVersion: true,
      hasPublicListing: true,
    })).toEqual({
      canPublish: true,
      message: "A newer applied configuration is ready for your review and approval.",
    });
  });

  it("offers first publication when there is no public listing", () => {
    expect(derivePublishReadiness(readyInput)).toEqual({
      canPublish: true,
      message: "Applied version 7 is ready to publish.",
    });
  });

  it("offers approve-and-republish for an up-to-date public listing", () => {
    expect(derivePublishReadiness({ ...readyInput, hasPublicListing: true })).toEqual({
      canPublish: true,
      message: "Applied version 7 is ready to approve and republish.",
    });
  });
});
