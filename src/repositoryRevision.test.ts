import { describe, expect, it } from "vitest";
import { repositoryFilesRevision } from "./repositoryRevision";
import type { ConfigFile } from "./types";

describe("repositoryFilesRevision", () => {
  it("is stable across file order and non-content metadata", async () => {
    const first = await repositoryFilesRevision([
      { content: "[printer]\n", path: "printer.cfg" },
      { content: "[stepper_x]\n", path: "hardware/stepper.cfg" },
    ]);
    const reorderedFiles: ConfigFile[] = [
      { content: "[stepper_x]\n", path: "hardware/stepper.cfg", public: true, role: "other" },
      { content: "[printer]\n", path: "printer.cfg", public: false, role: "entrypoint" },
    ];
    const reordered = await repositoryFilesRevision(reorderedFiles);

    expect(reordered).toBe(first);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when exact file content changes", async () => {
    const before = await repositoryFilesRevision([{ content: "max_velocity: 300\n", path: "printer.cfg" }]);
    const after = await repositoryFilesRevision([{ content: "max_velocity: 301\n", path: "printer.cfg" }]);

    expect(after).not.toBe(before);
  });
});
