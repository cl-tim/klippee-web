import { describe, expect, it } from "vitest";

import { createRepositoryForkPlan } from "../worker/repositoryFork";
import type { ConfigFile } from "./types";

const sourceFiles: ConfigFile[] = [
  { content: "[include macros.cfg]\n", path: "printer.cfg", public: false, role: "entrypoint" },
];

describe("createRepositoryForkPlan", () => {
  it("creates fork repository and version records from source metadata", () => {
    const plan = createRepositoryForkPlan({
      files: sourceFiles,
      input: {},
      repo: { name: "source-printer", title: "Source Printer" },
      repoId: "fork-repo-id",
      suffix: "abc123",
      timestamp: "2026-05-24T09:00:00.000Z",
      userId: "user-id",
      versionId: "fork-version-id",
      versionNumber: 7,
    });

    expect(plan.repositoryInsert).toEqual({
      created_at: "2026-05-24T09:00:00.000Z",
      id: "fork-repo-id",
      latest_version_id: "fork-version-id",
      name: "source-printer-fork-abc123",
      title: "Source Printer fork",
      updated_at: "2026-05-24T09:00:00.000Z",
      user_id: "user-id",
    });
    expect(plan.versionInsert.message).toBe("Fork from source-printer version 7");
    expect(plan.response.version.files).toBe(sourceFiles);
  });

  it("uses caller-provided title and slugged name before adding the unique suffix", () => {
    const plan = createRepositoryForkPlan({
      files: sourceFiles,
      input: { name: "Kitchen CoreXY!", title: "Kitchen CoreXY" },
      repo: { name: "source-printer", title: "Source Printer" },
      repoId: "fork-repo-id",
      suffix: "def456",
      timestamp: "2026-05-24T09:00:00.000Z",
      userId: "user-id",
      versionId: "fork-version-id",
      versionNumber: 2,
    });

    expect(plan.repositoryInsert.name).toBe("kitchen-corexy-def456");
    expect(plan.repositoryInsert.title).toBe("Kitchen CoreXY");
  });

  it("falls back to fork when provided names cannot produce a slug", () => {
    const plan = createRepositoryForkPlan({
      files: sourceFiles,
      input: { name: "!!!", title: "###" },
      repo: { name: "source-printer", title: "Source Printer" },
      repoId: "fork-repo-id",
      suffix: "xyz789",
      timestamp: "2026-05-24T09:00:00.000Z",
      userId: "user-id",
      versionId: "fork-version-id",
      versionNumber: 1,
    });

    expect(plan.repositoryInsert.name).toBe("fork-xyz789");
  });
});
