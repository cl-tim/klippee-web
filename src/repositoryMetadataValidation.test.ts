import { describe, expect, it } from "vitest";

import {
  maxConfigPathLength,
  maxConfigRoleBytes,
  maxRepositoryVersionMessageBytes,
  maxRepositoryVersionSourceBytes,
} from "../worker/constants";
import {
  configPathCollisionKey,
  describeInvalidFiles,
  normalizeConfigPath,
  parseFiles,
  parseRepositoryVersionMessage,
  parseRepositoryVersionSource,
} from "../worker/validation";

describe("persisted repository metadata bounds", () => {
  it("bounds config paths by UTF-8 bytes", () => {
    expect(normalizeConfigPath("a".repeat(maxConfigPathLength))).toHaveLength(maxConfigPathLength);
    expect(normalizeConfigPath("a".repeat(maxConfigPathLength + 1))).toBeNull();
    expect(normalizeConfigPath("\u00e9".repeat(maxConfigPathLength / 2))).not.toBeNull();
    expect(normalizeConfigPath("\u00e9".repeat(maxConfigPathLength / 2 + 1))).toBeNull();
  });

  it("normalizes and bounds roles before they enter a file manifest", () => {
    const accepted = parseFiles([{
      content: "[printer]\n",
      path: "printer.cfg",
      role: `  ${"r".repeat(maxConfigRoleBytes)}  `,
    }]);
    expect(accepted?.[0].role).toBe("r".repeat(maxConfigRoleBytes));

    const rejected = [{
      content: "[printer]\n",
      path: "printer.cfg",
      role: "r".repeat(maxConfigRoleBytes + 1),
    }];
    expect(parseFiles(rejected)).toBeNull();
    expect(describeInvalidFiles(rejected)).toContain(`${maxConfigRoleBytes} UTF-8 bytes`);
  });

  it("rejects duplicate normalized paths before capture protection or storage", () => {
    const duplicated = [
      { content: "serial: literal\n", path: "printer.cfg", role: "printer" },
      { content: "serial: ${KLIPPEE:beacon_serial}\n", path: " printer.cfg ", role: "printer" },
    ];

    expect(parseFiles(duplicated)).toBeNull();
    expect(describeInvalidFiles(duplicated)).toBe("Duplicate file path: printer.cfg");
  });

  it("rejects paths that collide on case-insensitive or Unicode-normalizing desktops", () => {
    const caseCollision = [
      { content: "one", path: "Macros/Beacon.cfg", role: "include" },
      { content: "two", path: "macros/beacon.cfg", role: "include" },
    ];
    const unicodeCollision = [
      { content: "one", path: "caf\u00e9.cfg", role: "include" },
      { content: "two", path: "cafe\u0301.cfg", role: "include" },
    ];

    expect(configPathCollisionKey(caseCollision[0].path)).toBe(configPathCollisionKey(caseCollision[1].path));
    expect(parseFiles(caseCollision)).toBeNull();
    expect(describeInvalidFiles(caseCollision)).toContain("Conflicting file paths");
    expect(parseFiles(unicodeCollision)).toBeNull();
  });

  it("bounds version messages by UTF-8 bytes and rejects non-strings", () => {
    expect(parseRepositoryVersionMessage("m".repeat(maxRepositoryVersionMessageBytes))).toEqual({
      ok: true,
      value: "m".repeat(maxRepositoryVersionMessageBytes),
    });
    expect(parseRepositoryVersionMessage("m".repeat(maxRepositoryVersionMessageBytes + 1))).toEqual({
      error: `Version message must be at most ${maxRepositoryVersionMessageBytes} UTF-8 bytes`,
      ok: false,
    });
    expect(parseRepositoryVersionMessage({ message: "not a string" })).toEqual({
      error: "Version message must be a string",
      ok: false,
    });
  });

  it("bounds version sources while preserving short custom labels", () => {
    expect(parseRepositoryVersionSource(`  ${"s".repeat(maxRepositoryVersionSourceBytes)}  `)).toEqual({
      ok: true,
      value: "s".repeat(maxRepositoryVersionSourceBytes),
    });
    expect(parseRepositoryVersionSource("s".repeat(maxRepositoryVersionSourceBytes + 1))).toEqual({
      error: `Version source must be at most ${maxRepositoryVersionSourceBytes} UTF-8 bytes`,
      ok: false,
    });
  });
});
