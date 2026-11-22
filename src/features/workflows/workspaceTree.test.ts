import { describe, expect, it } from "vitest";
import type { ConfigFile } from "../../types";
import {
  buildWorkspaceTree,
  filterWorkspaceTree,
  normalizeWorkspaceFolderPath,
  planWorkspaceMove,
  workspaceAncestorFolders,
} from "./workspaceTree";

function config(path: string, content = ""): ConfigFile {
  return { content, path, public: false, role: "config" };
}

describe("workspace tree", () => {
  it("groups path-based files into folders and keeps printer.cfg first at the root", () => {
    const tree = buildWorkspaceTree([
      config("macros/purge.cfg"),
      config("printer.cfg"),
      config("KAMP/Smart_Park.cfg"),
      config("KAMP/Adaptive_Meshing.cfg"),
    ]);

    expect(tree.map((node) => [node.kind, node.name])).toEqual([
      ["folder", "KAMP"],
      ["folder", "macros"],
      ["file", "printer.cfg"],
    ]);
    expect(tree[0].kind === "folder" ? tree[0].children.map((node) => node.name) : []).toEqual([
      "Adaptive_Meshing.cfg",
      "Smart_Park.cfg",
    ]);
  });

  it("keeps matching ancestors when filtering", () => {
    const tree = filterWorkspaceTree(
      buildWorkspaceTree([config("KAMP/Smart_Park.cfg"), config("macros/purge.cfg"), config("printer.cfg")]),
      "smart",
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe("folder");
    expect(tree[0].kind === "folder" ? tree[0].children[0].path : "").toBe("KAMP/Smart_Park.cfg");
  });

  it("normalizes safe folder paths and finds selected-file ancestors", () => {
    expect(normalizeWorkspaceFolderPath("./KAMP/nested/")).toBe("KAMP/nested");
    expect(normalizeWorkspaceFolderPath("../outside")).toBeNull();
    expect(workspaceAncestorFolders("KAMP/nested/file.cfg")).toEqual(["KAMP", "KAMP/nested"]);
  });
});

describe("workspace path moves", () => {
  it("moves every file in a folder and updates exact and wildcard includes", () => {
    const result = planWorkspaceMove(
      [
        config("printer.cfg", "[include ./KAMP/KAMP_Settings.cfg]\n[include KAMP/*.cfg]\n"),
        config("KAMP/KAMP_Settings.cfg"),
        config("KAMP/Smart_Park.cfg"),
      ],
      "KAMP",
      "macros/KAMP",
      "folder",
    );

    expect(result.error).toBeNull();
    expect(result.files?.map((file) => file.path)).toEqual([
      "printer.cfg",
      "macros/KAMP/KAMP_Settings.cfg",
      "macros/KAMP/Smart_Park.cfg",
    ]);
    expect(result.files?.[0].content).toBe(
      "[include ./macros/KAMP/KAMP_Settings.cfg]\n[include macros/KAMP/*.cfg]\n",
    );
    expect(result.includeReferences).toHaveLength(2);
  });

  it("rejects destination conflicts and moving a folder into itself", () => {
    const files = [config("KAMP/a.cfg"), config("macros/KAMP/a.cfg")];

    expect(planWorkspaceMove(files, "KAMP", "macros/KAMP", "folder").error).toBe(
      "macros/KAMP/a.cfg already exists",
    );
    expect(planWorkspaceMove(files, "KAMP", "KAMP/nested", "folder").error).toBe(
      "A folder cannot be moved inside itself",
    );
  });
});
