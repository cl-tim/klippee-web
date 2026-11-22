import { describe, expect, it } from "vitest";
import type { CloudDesiredConfiguration, CloudRepositoryVersion } from "./types";
import type { ConfigFile } from "../types";
import {
  effectiveLocalWorkspaceFiles,
  hasLocalWorkspaceDraft,
  historyFromCloudVersions,
  reconcileRepositoryWorkspace,
} from "./workspaceReconciliation";

function cloudVersion(
  versionNumber: number,
  files: ConfigFile[],
): CloudRepositoryVersion {
  return {
    created_at: `2026-08-0${versionNumber}T00:00:00.000Z`,
    files,
    id: `version-${versionNumber}`,
    message: `Version ${versionNumber}`,
    previous_version_id: versionNumber === 1 ? null : `version-${versionNumber - 1}`,
    source: "capture",
    version_number: versionNumber,
  };
}

function configFile(path: string, content: string): ConfigFile {
  return { content, path, public: false, role: "printer" };
}

const desiredPending: CloudDesiredConfiguration = {
  createdAt: "2026-08-10T00:00:00.000Z",
  files: [configFile("printer.cfg", "[printer]\n# desired\n")],
  pending: true,
  revision: "sha256:desired",
  source: "web-editor",
  versionId: null,
  versionNumber: 3,
};

describe("historyFromCloudVersions", () => {
  it("sorts by version number and chains previousId", () => {
    const files = [configFile("printer.cfg", "v")];
    const history = historyFromCloudVersions([
      cloudVersion(2, files),
      cloudVersion(1, files),
    ]);
    expect(history.map((version) => version.id)).toEqual([1, 2]);
    expect(history.map((version) => version.previousId)).toEqual([null, 1]);
  });
});

describe("reconcileRepositoryWorkspace", () => {
  it("seeds an editable structural draft for a brand-new empty repository", () => {
    const result = reconcileRepositoryWorkspace({
      cloudVersions: [],
      desired: null,
      localStructuralFiles: null,
      localDrafts: {},
      localBaseRevision: undefined,
      latestRevision: null,
      localRevision: null,
      preferredPath: "printer.cfg",
    });

    expect(result.history).toEqual([]);
    expect(result.draftFiles).toEqual([
      { content: "", path: "printer.cfg", public: false, role: "printer" },
    ]);
    expect(result.drafts).toEqual({});
    expect(result.filePath).toBe("printer.cfg");
    expect(result.content).toBe("");
    expect(result.workspaceBaseRevision).toBeNull();
  });

  it("adopts the authoritative pending desired draft when there is no local workspace", () => {
    const latestFiles = [configFile("printer.cfg", "[printer]\n# v2\n")];
    const result = reconcileRepositoryWorkspace({
      cloudVersions: [cloudVersion(1, [configFile("printer.cfg", "[printer]\n# v1\n")]), cloudVersion(2, latestFiles)],
      desired: desiredPending,
      localStructuralFiles: null,
      localDrafts: {},
      localBaseRevision: undefined,
      latestRevision: "sha256:latest",
      localRevision: null,
      preferredPath: "printer.cfg",
    });

    expect(result.history).toHaveLength(2);
    expect(result.draftFiles).toEqual(desiredPending.files);
    expect(result.drafts).toEqual({});
    expect(result.filePath).toBe("printer.cfg");
    expect(result.content).toBe("[printer]\n# desired\n");
    expect(result.workspaceBaseRevision).toBe("sha256:desired");
  });

  it("normalizes a local cache whose effective files already match the desired revision", () => {
    const result = reconcileRepositoryWorkspace({
      cloudVersions: [cloudVersion(1, [configFile("printer.cfg", "[printer]\n# v1\n")])],
      desired: desiredPending,
      localStructuralFiles: [configFile("printer.cfg", "[printer]\n# desired\n")],
      localDrafts: {},
      localBaseRevision: "sha256:older",
      latestRevision: "sha256:latest",
      localRevision: "sha256:desired",
      preferredPath: "printer.cfg",
    });

    expect(result.draftFiles).toEqual(desiredPending.files);
    expect(result.drafts).toEqual({});
    expect(result.workspaceBaseRevision).toBe("sha256:desired");
  });

  it("refreshes a local snapshot unchanged from its recorded baseline", () => {
    const result = reconcileRepositoryWorkspace({
      cloudVersions: [cloudVersion(1, [configFile("printer.cfg", "[printer]\n# v1\n")])],
      desired: desiredPending,
      localStructuralFiles: [configFile("printer.cfg", "[printer]\n# v1\n")],
      localDrafts: {},
      localBaseRevision: "sha256:latest",
      latestRevision: "sha256:latest",
      localRevision: "sha256:latest",
      preferredPath: "printer.cfg",
    });

    expect(result.draftFiles).toEqual(desiredPending.files);
    expect(result.drafts).toEqual({});
    expect(result.workspaceBaseRevision).toBe("sha256:desired");
  });

  it("keeps a divergent local workspace and its original staging baseline", () => {
    const localFiles = [
      configFile("printer.cfg", "[printer]\n# local structural\n"),
      configFile("macros.cfg", "[gcode_macro HOME]\n"),
    ];
    const localDrafts = { "macros.cfg": "[gcode_macro HOME]\n# edited\n" };
    const result = reconcileRepositoryWorkspace({
      cloudVersions: [cloudVersion(1, [configFile("printer.cfg", "[printer]\n# v1\n")])],
      desired: desiredPending,
      localStructuralFiles: localFiles,
      localDrafts,
      localBaseRevision: "sha256:base",
      latestRevision: "sha256:latest",
      localRevision: "sha256:divergent",
      preferredPath: "macros.cfg",
    });

    expect(result.draftFiles).toBe(localFiles);
    expect(result.drafts).toBe(localDrafts);
    expect(result.filePath).toBe("macros.cfg");
    expect(result.content).toBe("[gcode_macro HOME]\n# edited\n");
    expect(result.workspaceBaseRevision).toBe("sha256:base");
  });

  it("preserves an intentional reversion even after the cloud changes again", () => {
    const localFiles = [configFile("printer.cfg", "# restored immutable version\n")];
    const result = reconcileRepositoryWorkspace({ cloudVersions: [cloudVersion(1, localFiles)], desired: desiredPending,
      localStructuralFiles: localFiles, localDrafts: {}, localBaseRevision: "sha256:intervening-draft",
      latestRevision: "sha256:latest", localRevision: "sha256:latest", preferredPath: "printer.cfg" });
    expect(result.draftFiles).toEqual(localFiles);
    expect(result.workspaceBaseRevision).toBe("sha256:intervening-draft");
  });

  it("keeps content-only local edits visible when a cloud capture deletes their file", () => {
    const localBaseFiles = [configFile("printer.cfg", "# original\n")];
    const result = reconcileRepositoryWorkspace({ cloudVersions: [cloudVersion(2, [configFile("other.cfg", "# new capture\n")])],
      desired: desiredPending, localBaseFiles, localStructuralFiles: null, localDrafts: { "printer.cfg": "# unsaved edit\n" },
      localBaseRevision: "sha256:original", latestRevision: "sha256:latest", localRevision: "sha256:local", preferredPath: "printer.cfg" });
    expect(result.draftFiles).toEqual(localBaseFiles);
    expect(result.filePath).toBe("printer.cfg");
    expect(result.content).toBe("# unsaved edit\n");
    expect(result.workspaceBaseRevision).toBe("sha256:original");
  });

  it("falls back to the latest immutable revision when a divergent legacy cache has no baseline", () => {
    const localFiles = [configFile("printer.cfg", "[printer]\n# local\n")];
    const result = reconcileRepositoryWorkspace({
      cloudVersions: [cloudVersion(1, [configFile("printer.cfg", "[printer]\n# v1\n")])],
      desired: null,
      localStructuralFiles: localFiles,
      localDrafts: {},
      localBaseRevision: undefined,
      latestRevision: "sha256:latest",
      localRevision: "sha256:divergent",
      preferredPath: "missing.cfg",
    });

    expect(result.draftFiles).toBe(localFiles);
    expect(result.workspaceBaseRevision).toBe("sha256:latest");
    // The preferred path no longer exists, so the first file wins.
    expect(result.filePath).toBe("printer.cfg");
    expect(result.content).toBe("[printer]\n# local\n");
  });
});

describe("effectiveLocalWorkspaceFiles", () => {
  it("overlays content drafts on the structural file set", () => {
    const files = effectiveLocalWorkspaceFiles(
      [configFile("printer.cfg", "base")],
      { "printer.cfg": "edited" },
      [],
    );
    expect(files).toEqual([configFile("printer.cfg", "edited")]);
  });

  it("uses the latest cloud files when there is no structural draft", () => {
    const latest = [configFile("printer.cfg", "cloud")];
    expect(effectiveLocalWorkspaceFiles(null, {}, latest)).toEqual(latest);
    expect(hasLocalWorkspaceDraft(null, {})).toBe(false);
    expect(hasLocalWorkspaceDraft(null, { "printer.cfg": "x" })).toBe(true);
  });
});
