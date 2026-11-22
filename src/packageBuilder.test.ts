import { describe, expect, it } from "vitest";
import {
  extractIncludes,
  extractVariableCandidates,
  isImportableWorkspaceConfigPath,
  unsafeWorkspaceImportReason,
} from "./packageBuilder";
import type { ConfigFile } from "./types";

describe("extractVariableCandidates", () => {
  it("detects Beacon USB serial paths as device-path variables", () => {
    const files: ConfigFile[] = [
      {
        content: "[mcu]\nserial: /dev/serial/by-id/usb-Beacon_Beacon_RevH_123456-if00\n",
        path: "beacon.cfg",
        public: false,
        role: "calibration",
      },
    ];

    expect(extractVariableCandidates(files)).toEqual([
      expect.objectContaining({
        example: "/dev/serial/by-id/usb-Beacon_Beacon_RevH_123456-if00",
        label: "Mcu Serial",
        name: "mcu_serial",
        type: "device-path",
      }),
    ]);
  });
});

describe("isImportableWorkspaceConfigPath", () => {
  it("allows Klipper and addon .cfg definitions", () => {
    expect(isImportableWorkspaceConfigPath("printer.cfg")).toBe(true);
    expect(isImportableWorkspaceConfigPath("macros/start_print.cfg")).toBe(true);
    expect(isImportableWorkspaceConfigPath("KAMP/Adaptive_Meshing.cfg")).toBe(true);
    expect(isImportableWorkspaceConfigPath("beacon/beacon.cfg")).toBe(true);
  });

  it("rejects runtime, credential, hidden, backup, and non-cfg folder uploads", () => {
    expect(unsafeWorkspaceImportReason("saved_variables.cfg")).toBe("sensitive runtime or credential config");
    expect(unsafeWorkspaceImportReason("moonraker.secrets")).toBe("backup, archive, log, or secret file");
    expect(unsafeWorkspaceImportReason("moonraker.cfg")).toBe("sensitive runtime or credential config");
    expect(unsafeWorkspaceImportReason("klippee_variables.cfg")).toBe("sensitive runtime or credential config");
    expect(unsafeWorkspaceImportReason("macros/api_token.cfg")).toBe("sensitive runtime or credential config");
    expect(unsafeWorkspaceImportReason(".klippee/private.cfg")).toBe("hidden path");
    expect(unsafeWorkspaceImportReason("printer.cfg.bak")).toBe("backup, archive, log, or secret file");
    expect(unsafeWorkspaceImportReason("logs/moonraker.log")).toBe("backup, archive, log, or secret file");
    expect(unsafeWorkspaceImportReason("config.mksini")).toBe("backup, archive, log, or secret file");
  });
});

describe("extractIncludes", () => {
  it("resolves dot-prefixed, nested relative, and wildcard include paths", () => {
    const files: ConfigFile[] = [
      {
        content: [
          "[include ./KAMP/Adaptive_Meshing.cfg]",
          "[include macros/*.cfg]",
          "[include missing.cfg]",
        ].join("\n"),
        path: "printer.cfg",
        public: false,
        role: "entrypoint",
      },
      {
        content: "[include inner.cfg]\n",
        path: "sub/base.cfg",
        public: false,
        role: "include",
      },
      {
        content: "",
        path: "sub/inner.cfg",
        public: false,
        role: "include",
      },
      {
        content: "",
        path: "KAMP/Adaptive_Meshing.cfg",
        public: false,
        role: "calibration",
      },
      {
        content: "",
        path: "macros/start.cfg",
        public: false,
        role: "macro",
      },
    ];

    expect(extractIncludes(files)).toEqual(["missing.cfg"]);
  });
});
