import { describe, expect, it } from "vitest";
import type { PrinterRecord } from "../../app/types";
import { printerDesiredVersionId, summarizePrinterManagement } from "./printerManagement";

function printer(overrides: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    appliedVersionId: 0,
    createdAt: "2026-07-24T00:00:00.000Z",
    description: "",
    id: "printer-1",
    latestVersionId: 0,
    make: "",
    model: "",
    name: "Printer 1",
    packageIds: [],
    source: "manual",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("printer management status", () => {
  it("shows a profile without a repository as requiring setup", () => {
    expect(summarizePrinterManagement(printer())).toMatchObject({
      configLabel: "Setup required",
      setupState: "profile",
      tone: "attention",
    });
  });

  it("shows a linked repository without history as awaiting capture", () => {
    expect(summarizePrinterManagement(printer({ repositoryId: "repo-1" }))).toMatchObject({
      configLabel: "Awaiting capture",
      setupState: "capture",
    });
  });

  it("does not claim the latest cloud version is installed", () => {
    expect(summarizePrinterManagement(printer({
      latestVersionId: 3,
      repositoryId: "repo-1",
    }))).toMatchObject({
      configLabel: "Applied state unknown",
      tone: "muted",
    });
  });

  it("uses the latest cloud version as the target independently of the last applied version", () => {
    expect(printerDesiredVersionId(printer({ latestVersionId: 4 }))).toBe(4);
    expect(printerDesiredVersionId(printer({ appliedVersionId: 2, latestVersionId: 4 }))).toBe(4);
  });

  it("distinguishes an available update from a current configuration", () => {
    expect(summarizePrinterManagement(printer({
      appliedVersionId: 2,
      latestVersionId: 3,
      repositoryId: "repo-1",
    })).configLabel).toBe("Update available");
    expect(summarizePrinterManagement(printer({
      appliedVersionId: 3,
      latestVersionId: 3,
      repositoryId: "repo-1",
    })).configLabel).toBe("Configuration current");
  });
});
