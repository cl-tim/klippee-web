import { describe, expect, it } from "vitest";
import { correlateFindingsWithUsbTopology } from "./diagnosticUsbEvidence";
import type { DiagnosticBundleEvidence, DiagnosticFinding } from "./types";

const finding: DiagnosticFinding = {
  checks: [
    "Confirm that kernel USB path 2-1.2.1.2 maps to mcu_box1's configured serial endpoint before replacing hardware.",
    "Inspect the data path.",
  ],
  confidence: "high",
  detail: "mcu_box1 stopped responding. The kernel lines alone do not prove the mapping.",
  evidence: [{
    line: 4,
    message: "usb 2-1.2.1.2: USB disconnect, device number 22",
    session: 3,
    source: "kernel-journal.log",
    time: null,
  }],
  family: "communication",
  id: "shutdown-dump-lost-mcu-1",
  session: 3,
  severity: "error",
  title: "mcu_box1 was the non-responding MCU",
};

const bundle = {
  config: {
    pendingSave: false,
    pendingSaveItems: [],
    retainedSectionCount: 1,
    sectionCount: 1,
    sections: [{
      kind: "mcu",
      name: "mcu mcu_box1",
      options: { serial: "/dev/serial/by-id/usb-Klipper_QIDI_BOX_ABC-if00" },
    }],
    warnings: [],
  },
  usbSerialDevices: [{
    byId: "/dev/serial/by-id/usb-Klipper_QIDI_BOX_ABC-if00",
    manufacturer: "Klipper",
    product: "QIDI_BOX_V1_1.1.1",
    productId: "614e",
    serial: "ABC",
    tty: "/dev/ttyACM3",
    usbPath: "2-1.2.1.2",
    vendorId: "1d50",
  }],
} as DiagnosticBundleEvidence;

describe("USB serial diagnostic correlation", () => {
  it("proves a lost MCU's kernel path from active config and capture-time topology", () => {
    const [correlated] = correlateFindingsWithUsbTopology([finding], bundle);

    expect(correlated.detail).toContain("tying the kernel disconnect directly to mcu_box1");
    expect(correlated.detail).toContain("QIDI_BOX_V1_1.1.1");
    expect(correlated.evidence.at(-1)?.source).toBe("snapshots/usb-serial-topology.json");
    expect(correlated.checks.join(" ")).not.toContain("Confirm that kernel USB path");
  });

  it("does not infer a mapping when the kernel path differs", () => {
    const mismatched = {
      ...bundle,
      usbSerialDevices: [{ ...bundle.usbSerialDevices[0], usbPath: "2-1.4" }],
    };

    expect(correlateFindingsWithUsbTopology([finding], mismatched)[0]).toBe(finding);
  });
});
