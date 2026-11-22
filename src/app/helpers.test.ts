import { describe, expect, it } from "vitest";
import type { ConfigPackage, HistoryVersion } from "../types";
import {
  packageZipUrl,
  powershellQuote,
  reconcileCloudPrinters,
  shellCommandQuote,
  snapshotPrinterWorkspace,
} from "./helpers";
import type { PrinterRecord } from "./types";

function printer(overrides: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    appliedVersionId: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    description: "",
    id: "printer-1",
    latestVersionId: 1,
    make: "",
    model: "",
    name: "Original printer",
    packageIds: [],
    repositoryId: null,
    source: "manual",
    updatedAt: "2026-07-01T00:00:00.000Z",
    variableValues: {},
    ...overrides,
  };
}

const history: HistoryVersion[] = [
  {
    createdAt: "2026-07-01T00:00:00.000Z",
    files: [{ content: "[printer]\nmax_velocity: 300\n", path: "printer.cfg", public: false, role: "printer" }],
    id: 1,
    message: "Saved config",
    previousId: null,
    source: "manual",
  },
];

describe("printer workspace persistence", () => {
  it("snapshots saved files and unsaved drafts before changing printers", () => {
    const result = snapshotPrinterWorkspace(printer(), {
      history,
      workspaceDraftFiles: null,
      workspaceDrafts: { "printer.cfg": "[printer]\nmax_velocity: 350\n" },
      workspaceFilePath: "printer.cfg",
    });

    expect(result.history).toEqual(history);
    expect(result.workspaceDrafts?.["printer.cfg"]).toContain("350");
    expect(result.workspaceFilePath).toBe("printer.cfg");
  });

  it("keeps workspace data when fresh cloud metadata contains a rename", () => {
    const local = snapshotPrinterWorkspace(printer(), {
      history,
      workspaceDraftFiles: null,
      workspaceDrafts: { "printer.cfg": "local draft" },
      workspaceFilePath: "printer.cfg",
    });
    local.workspaceBaseRevision = "sha256:local-baseline";
    local.workspaceBaseFiles = history[0].files;
    const cloud = printer({
      name: "Renamed printer",
      updatedAt: "2026-07-02T00:00:00.000Z",
      variableValues: { max_accel: "2750" },
    });

    const [result] = reconcileCloudPrinters([local], [cloud]);

    expect(result.name).toBe("Renamed printer");
    expect(result.history).toEqual(history);
    expect(result.workspaceBaseRevision).toBe("sha256:local-baseline");
    expect(result.workspaceBaseFiles).toEqual(history[0].files);
    expect(result.workspaceDrafts).toEqual({ "printer.cfg": "local draft" });
    expect(result.variableValues).toEqual({ max_accel: "2750" });
  });

  it("keeps local-only values while permitted cloud values remain authoritative", () => {
    const local = printer({
      variableValues: { api_token: "local-secret-sentinel", max_accel: "2500" },
    });
    const cloud = printer({
      variableValues: { max_accel: "2750" },
    });

    const [result] = reconcileCloudPrinters([local], [cloud]);

    expect(result.variableValues).toEqual({
      api_token: "local-secret-sentinel",
      max_accel: "2750",
    });
  });

  it("treats the server printer list as authoritative after deletions", () => {
    const deleted = printer({ id: "deleted" });
    const retained = printer({ id: "retained" });

    expect(reconcileCloudPrinters([deleted, retained], [retained]).map((record) => record.id)).toEqual(["retained"]);
  });

  it("drops a saved browser baseline when the cloud printer was rebound", () => {
    const local = printer({
      repositoryId: "repo-old",
      workspaceBaseRevision: "sha256:old",
      workspaceDraftFiles: [{ content: "old repo", path: "printer.cfg", public: false, role: "printer" }],
      workspaceDrafts: { "printer.cfg": "old repo" },
      workspaceFilePath: "printer.cfg",
    });
    const cloud = printer({ repositoryId: "repo-new" });

    const [result] = reconcileCloudPrinters([local], [cloud]);

    expect(result.workspaceBaseRevision).toBeUndefined();
    expect(result.workspaceDraftFiles).toBeUndefined();
    expect(result.workspaceDrafts).toBeUndefined();
    expect(result.workspaceFilePath).toBeUndefined();
  });
});

describe("installer command quoting", () => {
  it("quotes apostrophes for POSIX shells and PowerShell", () => {
    expect(shellCommandQuote("Cora's printer")).toBe("'Cora'\\''s printer'");
    expect(powershellQuote("Cora's printer")).toBe("'Cora''s printer'");
  });
});

describe("package download URLs", () => {
  it("does not read declared prototype-name variables through inheritance", () => {
    const pkg = {
      files: [],
      id: "prototype-variable-package",
      name: "prototype-variable-package",
      variables: [{ name: "constructor", required: true, secret: false, type: "string" }],
    } as ConfigPackage;

    expect(new URL(packageZipUrl(pkg, {})).searchParams.has("constructor")).toBe(false);
  });

  it("keeps explicit secret-type values out of GET query strings", () => {
    const pkg = {
      files: [],
      id: "secret-type-package",
      name: "secret-type-package",
      variables: [{ name: "api_token", required: true, secret: false, type: "secret" }],
    } as ConfigPackage;

    expect(new URL(packageZipUrl(pkg, { api_token: "never-in-a-url" })).searchParams.has("api_token"))
      .toBe(false);
  });
});
