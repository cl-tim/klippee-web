import { describe, expect, it } from "vitest";

import { findRepositoryDiffVersions, parseRepositoryDiffParams } from "../worker/repositoryDiff";

describe("parseRepositoryDiffParams", () => {
  it("parses integer from and to query params", () => {
    expect(parseRepositoryDiffParams(new URL("https://klippee.test/api/repositories/repo/diff?from=2&to=5"))).toEqual({
      fromVersion: 2,
      toVersion: 5,
    });
  });

  it("returns null when either query param is missing or not an integer", () => {
    expect(parseRepositoryDiffParams(new URL("https://klippee.test/api/repositories/repo/diff?from=2"))).toBeNull();
    expect(
      parseRepositoryDiffParams(new URL("https://klippee.test/api/repositories/repo/diff?from=2.5&to=3")),
    ).toBeNull();
    expect(
      parseRepositoryDiffParams(new URL("https://klippee.test/api/repositories/repo/diff?from=before&to=3")),
    ).toBeNull();
  });
});

describe("findRepositoryDiffVersions", () => {
  const rows = [
    { files_json: "two", version_number: 2 },
    { files_json: "five", version_number: 5 },
  ];

  it("selects the requested before and after version rows", () => {
    expect(findRepositoryDiffVersions(rows, 2, 5)).toEqual({
      after: { files_json: "five", version_number: 5 },
      before: { files_json: "two", version_number: 2 },
    });
  });

  it("returns null when either requested row is missing", () => {
    expect(findRepositoryDiffVersions(rows, 2, 6)).toBeNull();
  });
});
