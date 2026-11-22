import { describe, expect, it } from "vitest";

import { maxRepositoryVersionMessageBytes } from "../worker/constants";
import { createEmptyRepositoryCreationPlan, createRepositoryCreationPlan } from "../worker/repositoryCreation";

describe("createRepositoryCreationPlan", () => {
  it("creates an unversioned repository for importing an existing printer", () => {
    const plan = createEmptyRepositoryCreationPlan({
      input: { name: "Workshop CoreXY", title: "Workshop CoreXY" },
      repoId: "repo-id",
      timestamp: "2026-07-20T10:00:00.000Z",
      userId: "user-id",
    });

    expect(plan?.repositoryInsert.latest_version_id).toBeNull();
    expect(plan?.response.version).toBeNull();
    expect(plan?.response.repository.name).toBe("workshop-corexy");
  });

  it("creates repository and initial version records from request metadata", () => {
    const plan = createRepositoryCreationPlan({
      input: {
        message: "Imported from printer",
        name: "Kitchen CoreXY!",
        title: "Kitchen CoreXY",
      },
      repoId: "repo-id",
      timestamp: "2026-05-24T10:00:00.000Z",
      userId: "user-id",
      versionId: "version-id",
    });

    expect(plan.repositoryInsert).toEqual({
      created_at: "2026-05-24T10:00:00.000Z",
      id: "repo-id",
      latest_version_id: "version-id",
      name: "kitchen-corexy",
      title: "Kitchen CoreXY",
      updated_at: "2026-05-24T10:00:00.000Z",
      user_id: "user-id",
    });
    expect(plan.versionInsert).toEqual({
      created_at: "2026-05-24T10:00:00.000Z",
      id: "version-id",
      message: "Imported from printer",
      previous_version_id: null,
      repository_id: "repo-id",
      source: "web-editor",
      version_number: 1,
    });
    expect(plan.response.repository.name).toBe("kitchen-corexy");
    expect(plan.response.version.message).toBe("Imported from printer");
  });

  it("uses the default title and initial version message when metadata is omitted", () => {
    const plan = createRepositoryCreationPlan({
      input: {},
      repoId: "repo-id",
      timestamp: "2026-05-24T10:00:00.000Z",
      userId: "user-id",
      versionId: "version-id",
    });

    expect(plan.repositoryInsert.title).toBe("Untitled printer");
    expect(plan.repositoryInsert.name).toBe("untitled-printer");
    expect(plan.versionInsert.message).toBe("Initial version");
  });

  it("returns null when the selected name cannot produce a slug", () => {
    expect(
      createRepositoryCreationPlan({
        input: { name: "!!!", title: "Kitchen CoreXY" },
        repoId: "repo-id",
        timestamp: "2026-05-24T10:00:00.000Z",
        userId: "user-id",
        versionId: "version-id",
      }),
    ).toBeNull();
  });

  it("refuses an initial message that exceeds the persisted metadata bound", () => {
    expect(
      createRepositoryCreationPlan({
        input: { message: "m".repeat(maxRepositoryVersionMessageBytes + 1) },
        repoId: "repo-id",
        timestamp: "2026-05-24T10:00:00.000Z",
        userId: "user-id",
        versionId: "version-id",
      }),
    ).toBeNull();
  });
});
