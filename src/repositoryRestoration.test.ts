import { describe, expect, it } from "vitest";

import { findRepositoryRestoreVersions, restoreRepositoryFileIntoLatest } from "../worker/repositoryRestoration";
import type { ConfigFile } from "./types";

const latestFiles: ConfigFile[] = [
  { content: "current printer", path: "printer.cfg", public: false, role: "entrypoint" },
  { content: "current macros", path: "macros.cfg", public: false, role: "macro" },
];

describe("restoreRepositoryFileIntoLatest", () => {
  it("replaces the matching latest file with source-version content", () => {
    const result = restoreRepositoryFileIntoLatest(
      [{ content: "old macros", path: "macros.cfg", public: false, role: "macro" }],
      latestFiles,
      "macros.cfg",
    );

    expect(result).toEqual([
      { content: "current printer", path: "printer.cfg", public: false, role: "entrypoint" },
      { content: "old macros", path: "macros.cfg", public: false, role: "macro" },
    ]);
  });

  it("adds a source file that is missing from the latest version in path order", () => {
    const result = restoreRepositoryFileIntoLatest(
      [{ content: "old include", path: "includes/base.cfg", public: false, role: "include" }],
      latestFiles,
      "includes/base.cfg",
    );

    expect(result?.map((file) => file.path)).toEqual(["includes/base.cfg", "macros.cfg", "printer.cfg"]);
  });

  it("returns null when the source version does not contain the requested path", () => {
    expect(restoreRepositoryFileIntoLatest(latestFiles, latestFiles, "missing.cfg")).toBeNull();
  });
});

describe("findRepositoryRestoreVersions", () => {
  const rows = [
    { files_json: "version-two", version_number: 2 },
    { files_json: "version-five", version_number: 5 },
    { files_json: "version-three", version_number: 3 },
  ];

  it("selects the requested source version and highest latest version", () => {
    expect(findRepositoryRestoreVersions(rows, 2)).toEqual({
      latestVersion: { files_json: "version-five", version_number: 5 },
      sourceVersion: { files_json: "version-two", version_number: 2 },
    });
  });

  it("returns null when the requested source version is missing", () => {
    expect(findRepositoryRestoreVersions(rows, 4)).toBeNull();
  });

  it("returns null when no latest version can be selected", () => {
    expect(findRepositoryRestoreVersions([], 2)).toBeNull();
  });
});
