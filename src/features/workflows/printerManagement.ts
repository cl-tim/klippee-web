import type { PrinterRecord } from "../../app/types";

export type PrinterSetupState = "profile" | "capture" | "ready";
export type PrinterStatusTone = "attention" | "muted" | "ready";

export type PrinterManagementSummary = {
  configDetail: string;
  configLabel: string;
  setupState: PrinterSetupState;
  tone: PrinterStatusTone;
};

export function printerDesiredVersionId(printer: PrinterRecord) {
  return printer.latestVersionId || 0;
}

export function summarizePrinterManagement(printer: PrinterRecord): PrinterManagementSummary {
  if (!printer.repositoryId) {
    return {
      configDetail: "Connect this printer to capture its current configuration.",
      configLabel: "Setup required",
      setupState: "profile",
      tone: "attention",
    };
  }

  if (!printer.latestVersionId) {
    return {
      configDetail: "The private connection is ready for its first capture.",
      configLabel: "Awaiting capture",
      setupState: "capture",
      tone: "attention",
    };
  }

  if (!printer.appliedVersionId) {
    return {
      configDetail: "Klippee has not received an applied-state report.",
      configLabel: "Applied state unknown",
      setupState: "ready",
      tone: "muted",
    };
  }

  const targetVersionId = printerDesiredVersionId(printer);
  if (targetVersionId && printer.appliedVersionId !== targetVersionId) {
    return {
      configDetail: "The desired configuration has not been applied to this printer.",
      configLabel: "Update available",
      setupState: "ready",
      tone: "attention",
    };
  }

  return {
    configDetail: "The printer reports that it matches the desired configuration.",
    configLabel: "Configuration current",
    setupState: "ready",
    tone: "ready",
  };
}
