import { describe, expect, it } from "vitest";
import { maxConfigPathLength, maxConfigRoleBytes } from "./constants";
import { configPathCollisionKey, normalizeConfigPath, normalizeConfigRole } from "./validation";

describe("normalizeConfigPath", () => {
  it("accepts and preserves a plain relative path", () => {
    expect(normalizeConfigPath("config/printer.cfg")).toBe("config/printer.cfg");
  });

  it("preserves the original character case", () => {
    expect(normalizeConfigPath("Config/Printer.CFG")).toBe("Config/Printer.CFG");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizeConfigPath("config\\macros\\printer.cfg")).toBe("config/macros/printer.cfg");
  });

  it("strips leading slashes so paths stay repository-relative", () => {
    expect(normalizeConfigPath("//etc/passwd")).toBe("etc/passwd");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeConfigPath("  printer.cfg  ")).toBe("printer.cfg");
  });

  it.each([
    ["parent traversal", "../secrets.cfg"],
    ["embedded traversal", "configs/../../secrets.cfg"],
    ["current-directory segment", "./printer.cfg"],
    ["backslash traversal", "..\\secrets.cfg"],
    ["empty segment", "configs//printer.cfg"],
  ])("rejects %s", (_label, path) => {
    expect(normalizeConfigPath(path)).toBeNull();
  });

  it.each([
    ["upper-case drive letter", "C:/printer.cfg"],
    ["lower-case drive letter", "c:\\printer.cfg"],
  ])("rejects an absolute Windows path with an %s", (_label, path) => {
    expect(normalizeConfigPath(path)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["slashes only", "///"],
  ])("rejects a %s path", (_label, path) => {
    expect(normalizeConfigPath(path)).toBeNull();
  });

  it("enforces the byte limit at the boundary", () => {
    const atLimit = "a".repeat(maxConfigPathLength);
    expect(normalizeConfigPath(atLimit)).toBe(atLimit);
    expect(normalizeConfigPath(`${atLimit}a`)).toBeNull();
  });

  it("measures the limit in UTF-8 bytes, not characters", () => {
    // "ő" encodes to 2 bytes, so 91 characters overflow the 180-byte limit
    // while 90 fit exactly.
    expect(normalizeConfigPath("\u0151".repeat(90))).toBe("\u0151".repeat(90));
    expect(normalizeConfigPath("\u0151".repeat(91))).toBeNull();
  });
});

describe("configPathCollisionKey", () => {
  it("lower-cases the path", () => {
    expect(configPathCollisionKey("Config/Printer.CFG")).toBe("config/printer.cfg");
  });

  it("normalizes Unicode to NFC so composed and decomposed forms collide", () => {
    const composed = "caf\u00e9.cfg";
    const decomposed = "cafe\u0301.cfg";
    expect(configPathCollisionKey(decomposed)).toBe(configPathCollisionKey(composed));
  });

  it("keeps distinct paths distinct", () => {
    expect(configPathCollisionKey("a.cfg")).not.toBe(configPathCollisionKey("b.cfg"));
  });
});

describe("normalizeConfigRole", () => {
  it("defaults an omitted role to include", () => {
    expect(normalizeConfigRole(undefined)).toBe("include");
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["an object", { role: "macro" }],
  ])("rejects %s", (_label, value) => {
    expect(normalizeConfigRole(value)).toBeNull();
  });

  it("rejects empty and whitespace-only roles", () => {
    expect(normalizeConfigRole("")).toBeNull();
    expect(normalizeConfigRole("   ")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeConfigRole("  macro  ")).toBe("macro");
  });

  it("enforces the role byte limit at the boundary", () => {
    const atLimit = "r".repeat(maxConfigRoleBytes);
    expect(normalizeConfigRole(atLimit)).toBe(atLimit);
    expect(normalizeConfigRole(`${atLimit}r`)).toBeNull();
  });
});
