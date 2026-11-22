import { describe, expect, it } from "vitest";
import { accountStorageKey, createAccountStorage } from "../../storage";
import {
  loadOpenScadWorkspace,
  openScadWorkspaceStorageName,
  saveOpenScadWorkspace,
} from "./workspaceStorage";

describe("OpenSCAD workspace storage", () => {
  it("restores SCAD files, the entry file, and parameter values", async () => {
    const storage = await createAccountStorage("user-a");
    saveOpenScadWorkspace(storage, {
      files: [
        { engine: "openscad", name: "main.scad", source: "include <lib/shape.scad>;\nshape();" },
        { engine: "openscad", name: "lib/shape.scad", source: "module shape() { cube(12); }" },
      ],
      mainFile: "main.scad",
      parameterValues: { size: 12 },
    });

    expect(loadOpenScadWorkspace(storage)).toEqual({
      files: [
        { engine: "openscad", name: "main.scad", source: "include <lib/shape.scad>;\nshape();" },
        { engine: "openscad", name: "lib/shape.scad", source: "module shape() { cube(12); }" },
      ],
      mainFile: "main.scad",
      parameterValues: { size: 12 },
    });
  });

  it("ignores unsafe or malformed stored workspaces", async () => {
    localStorage.setItem(accountStorageKey("user-a", openScadWorkspaceStorageName), JSON.stringify({
      files: [{ name: "../private.scad", source: "cube(1);" }],
      mainFile: "../private.scad",
      parameterValues: {},
      version: 1,
    }));
    const storage = await createAccountStorage("user-a");

    expect(loadOpenScadWorkspace(storage)).toBeNull();
  });

  it("only stores editable OpenSCAD sources", async () => {
    const storage = await createAccountStorage("user-a");
    saveOpenScadWorkspace(storage, {
      files: [
        { engine: "build123d", name: "converted.build123d.py", plan: {}, source: "import build123d as b3d" },
        { engine: "openscad", name: "model.scad", source: "cube(8);" },
      ],
      mainFile: "converted.build123d.py",
      parameterValues: {},
    });

    expect(loadOpenScadWorkspace(storage)).toMatchObject({
      files: [{ engine: "openscad", name: "model.scad", source: "cube(8);" }],
      mainFile: "model.scad",
    });
  });

  it("reports workspaces that cannot be restored within the file limit", async () => {
    const storage = await createAccountStorage("user-a");
    expect(() => saveOpenScadWorkspace(storage, {
      files: Array.from({ length: 33 }, (_, index) => ({
        engine: "openscad" as const,
        name: `part-${index}.scad`,
        source: "cube(1);",
      })),
      mainFile: "part-0.scad",
      parameterValues: {},
    })).toThrow("browser storage limits");
  });

  it("keeps source isolated by account and ignores the legacy unowned key", async () => {
    const userA = await createAccountStorage("user-a");
    const userB = await createAccountStorage("user-b");
    const anonymous = await createAccountStorage(null);
    const snapshot = {
      files: [{ engine: "openscad" as const, name: "private.scad", source: "cube(42);" }],
      mainFile: "private.scad",
      parameterValues: {},
    };

    localStorage.setItem("klippee.mvp.openScadWorkspace", JSON.stringify({ ...snapshot, version: 1 }));
    saveOpenScadWorkspace(userA, snapshot);

    expect(loadOpenScadWorkspace(userA)?.files[0].source).toBe("cube(42);");
    expect(loadOpenScadWorkspace(userB)).toBeNull();
    expect(loadOpenScadWorkspace(anonymous)).toBeNull();
  });
});
