import { describe, expect, it } from "vitest";

import type { DesiredConfiguration } from "../worker/desiredConfiguration";
import { buildSyncSnapshotShellScript, buildSyncStatusText } from "../worker/syncResponses";
import type { PrinterRow, RepositoryRow, RepositoryVersionRow, StoredConfigFile } from "../worker/types";

const repository: RepositoryRow = {
  created_at: "2026-05-24T10:00:00.000Z",
  id: "repo-id",
  latest_version_id: "version-id",
  name: "bench-printer",
  title: "Bench Printer",
  updated_at: "2026-05-24T11:00:00.000Z",
};

const printer: PrinterRow = {
  applied_at: "2026-05-24T11:30:00.000Z",
  applied_version_id: 2,
  created_at: "2026-05-24T10:00:00.000Z",
  definition_json: "{}",
  description: "Printer",
  id: "printer-id",
  latest_version_id: 5,
  make: "Voron",
  model: "Trident",
  name: "Bench printer",
  package_ids_json: "[]",
  repository_id: "repo-id",
  source: "manual",
  updated_at: "2026-05-24T11:00:00.000Z",
  variable_values_json: "{}",
};

const version: RepositoryVersionRow = {
  created_at: "2026-05-24T12:00:00.000Z",
  files_json: "[]",
  id: "version-id",
  message: "Last applied configuration",
  previous_version_id: null,
  source: "web-editor",
  version_number: 4,
};

const pendingDesired: DesiredConfiguration = {
  files: [{ content: "[printer]\nkinematics: corexy\n", path: "printer.cfg", public: false, role: "printer" }],
  pending: true,
  pendingFilesJson: "pending-manifest",
  revision: "sha256:pending-revision",
  version: {
    created_at: "2026-05-24T12:00:00.000Z",
    id: null,
    message: "Draft changes not yet applied to this printer",
    previous_version_id: version.id,
    source: "pending",
    version_number: 5,
  },
};

describe("buildSyncStatusText", () => {
  it("renders last-applied printer state and the pending target as separate fields", () => {
    expect(buildSyncStatusText({ desired: pendingDesired, printer, repository, repositoryId: "repo-id" })).toBe(
      [
        "repository_id=repo-id",
        "repository_name=bench-printer",
        "printer_id=printer-id",
        "printer_name=Bench printer",
        "applied_version=2",
        "applied_at=2026-05-24T11:30:00.000Z",
        "target_version=5",
        "target_id=",
        "target_revision=sha256:pending-revision",
        "target_pending=1",
        "target_source=pending",
        "target_created_at=2026-05-24T12:00:00.000Z",
        "target_message=Draft changes not yet applied to this printer",
        "",
      ].join("\n"),
    );
  });

  it("uses empty field values when no printer or target version is available", () => {
    expect(buildSyncStatusText({ desired: null, printer: null, repository: null, repositoryId: "repo-id" })).toContain(
      "repository_id=repo-id\nrepository_name=\nprinter_id=\nprinter_name=\napplied_version=\napplied_at=\ntarget_version=",
    );
  });
});

describe("buildSyncSnapshotShellScript", () => {
  it("embeds file content, metadata, and quoted paths in the generated shell script", () => {
    const files: StoredConfigFile[] = [
      { content: "[stepper_x]\n", path: "printer.cfg" },
      { content: "danger='quoted'\n", path: "macros/say 'hi'.cfg" },
    ];

    const script = buildSyncSnapshotShellScript({
      files,
      printer,
      repositoryId: "repo-id",
      revision: "sha256:applied-revision",
      version,
    });

    expect(script).toContain("#!/bin/sh\nset -eu\n");
    expect(script).toContain("assert_safe_path 'printer.cfg'");
    expect(script).toContain("refusing linked config parent");
    expect(script).toContain("refusing linked config file");
    expect(script).toContain("write_file 'printer.cfg' <<'KLIPPEE_FILE'\nW3N0ZXBwZXJfeF0K\nKLIPPEE_FILE");
    expect(script).toContain("write_file 'macros/say '\\''hi'\\''.cfg' <<'KLIPPEE_FILE'");
    expect(script).toContain("repository_id=repo-id\nprinter_id=printer-id\nversion=4\nversion_id=version-id\nrevision=sha256:applied-revision");
    expect(script.endsWith("\n")).toBe(true);
  });
});
