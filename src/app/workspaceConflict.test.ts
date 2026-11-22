import { describe, expect, it } from "vitest";
import { resolveWorkspaceFiles, reviewWorkspaceFiles } from "./workspaceConflict";
import type { ConfigFile } from "../types";

const file = (path: string, content: string): ConfigFile => ({ path, content, role: "printer", public: false });
describe("three-way workspace file review", () => {
  it("preserves independent edits, additions and deletions", () => {
    const base = [file("printer.cfg", "base"), file("macros.cfg", "base"), file("removed.cfg", "base")];
    const local = [file("printer.cfg", "local"), file("macros.cfg", "base"), file("new.cfg", "new")];
    const cloud = [file("printer.cfg", "base"), file("macros.cfg", "cloud"), file("removed.cfg", "base")];
    expect(resolveWorkspaceFiles(reviewWorkspaceFiles(base, local, cloud), {})).toEqual([
      file("macros.cfg", "cloud"), file("new.cfg", "new"), file("printer.cfg", "local"),
    ]);
  });
  it("requires explicit resolution for competing edits, including delete versus edit", () => {
    const rows = reviewWorkspaceFiles([file("printer.cfg", "base")], [], [file("printer.cfg", "cloud")]);
    expect(rows[0].suggested).toBeNull();
    expect(resolveWorkspaceFiles(rows, {})).toBeNull();
    expect(resolveWorkspaceFiles(rows, { "printer.cfg": "local" })).toEqual([]);
    expect(resolveWorkspaceFiles(rows, { "printer.cfg": "cloud" })).toEqual([file("printer.cfg", "cloud")]);
  });
  it("does not invent a missing baseline or silently choose either differing side", () => {
    const rows = reviewWorkspaceFiles(null, [file("printer.cfg", "local")], [file("printer.cfg", "cloud")]);
    expect(rows[0]).toMatchObject({ baseline: undefined, suggested: null });
    expect(resolveWorkspaceFiles(rows, {})).toBeNull();
  });
  it("keeps identical changes without a conflict and preserves the selected metadata", () => {
    const local = { ...file("printer.cfg", "same"), public: false };
    const cloud = { ...local, public: true };
    const rows = reviewWorkspaceFiles(null, [local], [cloud]);
    expect(resolveWorkspaceFiles(rows, {})).toEqual([local]);
    expect(resolveWorkspaceFiles(rows, { "printer.cfg": "cloud" })).toEqual([cloud]);
  });
  it("handles competing additions and a file deleted by both sides", () => {
    const rows = reviewWorkspaceFiles([file("removed.cfg", "base")], [file("new.cfg", "local")], [file("new.cfg", "cloud")]);
    expect(rows.map(row => row.path)).toEqual(["new.cfg", "removed.cfg"]);
    expect(resolveWorkspaceFiles(rows, { "new.cfg": "local" })).toEqual([file("new.cfg", "local")]);
  });
});
