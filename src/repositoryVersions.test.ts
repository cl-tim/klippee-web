import { describe, expect, it } from "vitest";

import { hydrateRepositoryVersions } from "../worker/repositoryVersions";
import type { ConfigFile } from "./types";

const files: ConfigFile[] = [
  { content: "[printer]\n", path: "printer.cfg", public: false, role: "entrypoint" },
];

describe("hydrateRepositoryVersions", () => {
  it("loads files for repository version rows and removes raw files_json", async () => {
    const versions = await hydrateRepositoryVersions(
      [
        {
          created_at: "2026-05-24T10:00:00.000Z",
          files_json: "manifest-one",
          id: "version-1",
          message: "Initial version",
          previous_version_id: null,
          source: "web-editor",
          version_number: 1,
        },
      ],
      async (filesJson) => (filesJson === "manifest-one" ? files : null),
    );

    expect(versions).toEqual([
      {
        created_at: "2026-05-24T10:00:00.000Z",
        files,
        id: "version-1",
        message: "Initial version",
        previous_version_id: null,
        source: "web-editor",
        version_number: 1,
      },
    ]);
    expect("files_json" in versions[0]).toBe(false);
  });

  it("returns null when any version files cannot be loaded", async () => {
    await expect(
      hydrateRepositoryVersions(
        [
          {
            created_at: "2026-05-24T10:00:00.000Z",
            files_json: "missing",
            id: "version-1",
            message: "Initial version",
            previous_version_id: null,
            source: "web-editor",
            version_number: 1,
          },
        ],
        async () => null,
      ),
    ).resolves.toBeNull();
  });
});
