import { describe, expect, it } from "vitest";

import type { DesiredConfiguration } from "../worker/desiredConfiguration";
import { buildRepositorySyncStatus } from "../worker/repositorySyncStatus";
import type { PrinterRow, RepositoryRow } from "../worker/types";

const repository: RepositoryRow = {
  created_at: "2026-05-24T10:00:00.000Z",
  id: "repo-id",
  latest_version_id: "version-id",
  name: "bench-printer",
  title: "Bench Printer",
  updated_at: "2026-05-24T11:00:00.000Z",
};

const printer: PrinterRow = {
  applied_at: "2026-05-24T12:05:00.000Z",
  applied_version_id: 5,
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

const latest = {
  created_at: "2026-05-24T12:00:00.000Z",
  id: "latest-id",
  message: "Last applied configuration",
  source: "printer-apply",
  version_number: 5,
};

const appliedDesired: DesiredConfiguration = {
  files: [{ content: "[printer]\nkinematics: corexy\n", path: "printer.cfg", public: false, role: "printer" }],
  pending: false,
  pendingFilesJson: null,
  revision: "sha256:applied-revision",
  version: {
    ...latest,
    previous_version_id: "previous-id",
  },
};

const pendingDesired: DesiredConfiguration = {
  files: [
    ...appliedDesired.files,
    { content: "[gcode_macro START_PRINT]\n", path: "macros.cfg", public: false, role: "macro" },
  ],
  pending: true,
  pendingFilesJson: "pending-manifest",
  revision: "sha256:pending-revision",
  version: {
    created_at: "2026-05-24T12:10:00.000Z",
    id: null,
    message: "Draft changes not yet applied to this printer",
    previous_version_id: latest.id,
    source: "pending",
    version_number: 6,
  },
};

describe("buildRepositorySyncStatus", () => {
  it("reports a pending desired configuration separately from the last applied version", () => {
    expect(
      buildRepositorySyncStatus({
        desired: pendingDesired,
        latest,
        printer,
        repository,
      }),
    ).toMatchObject({
      appliedVersion: { version_number: 5 },
      latestVersion: { version_number: 5 },
      pendingConfiguration: {
        fileCount: 2,
        revision: "sha256:pending-revision",
        updatedAt: "2026-05-24T12:10:00.000Z",
      },
      printer: { appliedAt: "2026-05-24T12:05:00.000Z", appliedVersionId: 5 },
      targetRevision: "sha256:pending-revision",
      targetVersionNumber: 6,
      updateAvailable: true,
    });
  });

  it("reports current when the desired configuration is the last applied version", () => {
    expect(buildRepositorySyncStatus({
      desired: appliedDesired,
      latest,
      printer,
      repository,
    })).toMatchObject({
      appliedVersion: { version_number: 5 },
      pendingConfiguration: null,
      targetRevision: "sha256:applied-revision",
      targetVersionNumber: 5,
      updateAvailable: false,
    });
  });

  it("uses latest as target when no printer is bound", () => {
    expect(
      buildRepositorySyncStatus({
        desired: null,
        latest: {
          created_at: "2026-05-24T12:00:00.000Z",
          id: "latest-id",
          message: "Latest",
          source: "web-editor",
          version_number: 3,
        },
        printer: null,
        repository,
      }),
    ).toMatchObject({
      appliedVersion: null,
      printer: null,
      targetVersionNumber: 3,
      updateAvailable: true,
    });
  });
});
