import { describe, expect, it } from "vitest";
import {
  parseForkResponse,
  parseLogoutResponse,
  parsePrinterPublicationCandidateResponse,
  parsePublicPackageApprovalStatusResponse,
  parseRepositoryVersionsResponse,
  verifyRepositoryVersionsResponse,
} from "./responseGuards";

describe("content-addressed repository history", () => {
  const hash = "a".repeat(64);
  const content = "[printer]\n# café €\n";
  const reference = {
    byteLength: new TextEncoder().encode(content).byteLength,
    path: "printer.cfg",
    public: false,
    role: "printer",
    sha256: hash,
  };
  const version = {
    created_at: "2026-10-08T00:00:00Z",
    files: [reference],
    id: "version-1",
    message: "Captured configuration",
    previous_version_id: null,
    source: "capture",
    version_number: 1,
  };
  const desired = {
    createdAt: version.created_at,
    files: [reference],
    pending: false,
    revision: "revision-1",
    source: "capture",
    versionId: version.id,
    versionNumber: 1,
  };
  const response = () => ({
    storageFormat: "content-addressed-v1",
    blobs: { [hash]: content },
    desired,
    versions: [version, { ...version, id: "version-2", version_number: 2 }],
  });

  it("reconstructs every version and desired workspace from one Unicode body", () => {
    const parsed = parseRepositoryVersionsResponse(response());
    const file = { content, path: "printer.cfg", public: false, role: "printer" };
    expect(parsed?.versions.map((item) => item.files)).toEqual([[file], [file]]);
    expect(parsed?.desired).toEqual({ ...desired, files: [file] });
  });

  it("rejects missing bodies, invalid references, and byte-length mismatches", () => {
    expect(parseRepositoryVersionsResponse({ ...response(), blobs: {} })).toBeNull();
    for (const invalid of [
      { sha256: "not-a-hash" },
      { byteLength: content.length },
      { byteLength: -1 },
      { public: "false" },
    ]) {
      expect(parseRepositoryVersionsResponse({
        ...response(), versions: [{ ...version, files: [{ ...reference, ...invalid }] }],
      })).toBeNull();
    }
  });

  it("rejects unknown formats and malformed desired manifests", () => {
    expect(parseRepositoryVersionsResponse({ ...response(), storageFormat: "v99" })).toBeNull();
    expect(parseRepositoryVersionsResponse({
      ...response(), desired: { ...desired, files: [{ ...reference, sha256: "b".repeat(64) }] },
    })).toBeNull();
  });

  it("continues accepting the existing full-file response", () => {
    const legacy = {
      desired: null,
      versions: [{ ...version, files: [{ content, path: "printer.cfg", public: false, role: "printer" }] }],
    };
    expect(parseRepositoryVersionsResponse(legacy)).toEqual(legacy);
  });

  it("rejects same-length corrupted content under a claimed hash", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const actualHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const verifiedResponse = {
      ...response(),
      blobs: { [actualHash]: content },
      desired: null,
      versions: [{ ...version, files: [{ ...reference, sha256: actualHash }] }],
    };
    expect(await verifyRepositoryVersionsResponse(verifiedResponse)).not.toBeNull();
    expect(await verifyRepositoryVersionsResponse({
      ...verifiedResponse, blobs: { [actualHash]: content.replace("printer", "plinter") },
    })).toBeNull();
  });
});

describe("parseForkResponse", () => {
  const forkVersion = {
    created_at: "2026-08-11T00:00:00.000Z",
    files: [{ content: "[printer]\n", path: "printer.cfg", public: false, role: "printer" }],
    id: "version-fork",
    message: "Fork from source-printer version 3",
    previous_version_id: null,
    source: "fork",
    version_number: 1,
  };

  it("accepts a fork response with repository metadata and the seeded version", () => {
    expect(parseForkResponse({
      repository: { id: "repo-fork", name: "printer-fork-abc" },
      version: forkVersion,
    })).toEqual({
      repository: { id: "repo-fork", name: "printer-fork-abc" },
      version: forkVersion,
    });
  });

  it("rejects responses missing the repository or with a malformed version", () => {
    expect(parseForkResponse(null)).toBeNull();
    expect(parseForkResponse({ version: forkVersion })).toBeNull();
    expect(parseForkResponse({
      repository: { id: "repo-fork" },
      version: forkVersion,
    })).toBeNull();
    expect(parseForkResponse({
      repository: { id: "repo-fork", name: "printer-fork-abc" },
      version: { ...forkVersion, version_number: "1" },
    })).toBeNull();
    expect(parseForkResponse({
      repository: { id: "repo-fork", name: "printer-fork-abc" },
      version: { ...forkVersion, files: "printer.cfg" },
    })).toBeNull();
  });
});

describe("parseLogoutResponse", () => {
  it("accepts only an explicit successful logout acknowledgement", () => {
    expect(parseLogoutResponse({ ok: true })).toEqual({ ok: true });
    expect(parseLogoutResponse({ ok: false })).toBeNull();
    expect(parseLogoutResponse({})).toBeNull();
  });
});

describe("parsePublicPackageApprovalStatusResponse", () => {
  it("accepts the owner approval status contract", () => {
    expect(parsePublicPackageApprovalStatusResponse({
      status: {
        approvedVersionId: "version-approved",
        currentAppliedVersionId: "version-current",
        hasUnpublishedAppliedVersion: true,
        linked: true,
      },
    })).toEqual({
      status: {
        approvedVersionId: "version-approved",
        autoUpdateEnabled: false,
        autoUpdateError: null,
        currentAppliedVersionId: "version-current",
        hasUnpublishedAppliedVersion: true,
        linked: true,
      },
    });
  });

  it("rejects incomplete or mistyped status responses", () => {
    expect(parsePublicPackageApprovalStatusResponse({
      status: {
        approvedVersionId: null,
        currentAppliedVersionId: null,
        hasUnpublishedAppliedVersion: "yes",
        linked: true,
      },
    })).toBeNull();
    expect(parsePublicPackageApprovalStatusResponse({ status: { linked: false } })).toBeNull();
  });
});

describe("parsePrinterPublicationCandidateResponse", () => {
  it("accepts a null candidate and a complete applied snapshot", () => {
    expect(parsePrinterPublicationCandidateResponse({ candidate: null })).toEqual({ candidate: null });
    expect(parsePrinterPublicationCandidateResponse({
      candidate: {
        appliedAt: "2026-08-04T01:02:03.000Z",
        files: [{ content: "[printer]\n", path: "printer.cfg", public: false, role: "printer" }],
        repositoryId: "repo-printer",
        versionId: "version-applied",
        versionNumber: 7,
      },
    })).toEqual({
      candidate: {
        appliedAt: "2026-08-04T01:02:03.000Z",
        files: [{ content: "[printer]\n", path: "printer.cfg", public: false, role: "printer" }],
        repositoryId: "repo-printer",
        versionId: "version-applied",
        versionNumber: 7,
      },
    });
  });

  it("rejects incomplete candidates and malformed files", () => {
    expect(parsePrinterPublicationCandidateResponse({
      candidate: {
        appliedAt: null,
        files: [],
        repositoryId: "repo-printer",
        versionId: "version-applied",
        versionNumber: "7",
      },
    })).toBeNull();
    expect(parsePrinterPublicationCandidateResponse({
      candidate: {
        appliedAt: "not-a-date",
        files: [],
        repositoryId: "repo-printer",
        versionId: "version-applied",
        versionNumber: 7,
      },
    })).toBeNull();
    expect(parsePrinterPublicationCandidateResponse({
      candidate: {
        appliedAt: null,
        files: [{ content: "[printer]\n", path: "printer.cfg", role: "printer" }],
        repositoryId: "repo-printer",
        versionId: "version-applied",
        versionNumber: 7,
      },
    })).toBeNull();
  });
});
