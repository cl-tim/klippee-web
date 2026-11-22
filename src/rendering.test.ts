import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { ConfigPackage } from "./types";
import {
  createPackageZip,
  PackageRenderLimitError,
  declaredPackageVariableValues,
  renderFiles,
  validateVariables,
} from "./rendering";

const packageFixture: ConfigPackage = {
  description: "Browser rendering fixture",
  files: [
    { content: "${KLIPPEE:value}", path: "printer.cfg", public: true, role: "printer" },
    { content: "${KLIPPEE:value}", path: "macros.cfg", public: true, role: "macro" },
  ],
  hardware: [],
  id: "browser-rendering-fixture",
  name: "browser-rendering-fixture",
  printer: "Test printer",
  tags: [],
  title: "Browser rendering fixture",
  variables: [{
    description: "Browser value",
    label: "Value",
    name: "value",
    required: true,
    secret: false,
    type: "string",
  }],
  version: "1",
  warnings: [],
};

describe("browser package rendering", () => {
  it("applies the same aggregate UTF-8 preflight as the Worker", () => {
    expect(renderFiles(packageFixture.files, { value: "éé" }, 8).map((file) => file.content)).toEqual(["éé", "éé"]);
    expect(() => renderFiles(packageFixture.files, { value: "éé" }, 7)).toThrow(PackageRenderLimitError);
  });

  it("sends only values declared by the selected package", () => {
    expect(declaredPackageVariableValues(packageFixture, {
      unrelated_secret: "must-not-leave-browser",
      value: "safe",
    })).toEqual({ value: "safe" });
  });

  it("does not substitute unrelated local values into a browser ZIP", async () => {
    const pkg = {
      ...packageFixture,
      files: [{
        ...packageFixture.files[0],
        content: "${KLIPPEE:value} ${KLIPPEE:unrelated_secret}",
      }],
    };
    const blob = await createPackageZip(pkg, {
      unrelated_secret: "must-not-enter-archive",
      value: "safe",
    });
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));

    expect(strFromU8(archive["printer.cfg"])).toBe("safe ${KLIPPEE:unrelated_secret}");
  });

  it("treats inherited prototype names as missing", () => {
    const pkg = {
      ...packageFixture,
      variables: [{ ...packageFixture.variables[0], name: "constructor" }],
    };

    expect(validateVariables(pkg, {})).toEqual({ constructor: "Required" });
  });
});
