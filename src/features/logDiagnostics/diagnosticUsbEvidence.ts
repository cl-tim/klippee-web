import type {
  DiagnosticBundleEvidence,
  DiagnosticFinding,
} from "./types";

export function correlateFindingsWithUsbTopology(
  findings: DiagnosticFinding[],
  bundle: DiagnosticBundleEvidence,
): DiagnosticFinding[] {
  if (!bundle.config || !bundle.usbSerialDevices.length) return findings;
  return findings.map((finding) => correlateFinding(finding, bundle));
}

function correlateFinding(
  finding: DiagnosticFinding,
  bundle: DiagnosticBundleEvidence,
): DiagnosticFinding {
  if (!finding.id.startsWith("shutdown-dump-lost-mcu-")) return finding;
  const lostMcu = /^(.+?) was the non-responding MCU$/.exec(finding.title)?.[1] ?? "";
  if (!lostMcu) return finding;
  const sectionName = lostMcu === "mcu" ? "mcu" : `mcu ${lostMcu}`;
  const serialPath = bundle.config?.sections.find((section) =>
    section.kind === "mcu" && section.name.toLowerCase() === sectionName.toLowerCase())
    ?.options.serial;
  if (!serialPath) return finding;
  const device = bundle.usbSerialDevices.find((candidate) => candidate.byId === serialPath);
  if (!device) return finding;
  const kernelPaths = new Set(finding.evidence.flatMap((evidence) => {
    const path = /\busb\s+([0-9]+-[0-9.]+):\s+USB disconnect\b/i.exec(evidence.message)?.[1];
    return path ? [path] : [];
  }));
  if (!kernelPaths.has(device.usbPath)) return finding;

  const identity = [device.product, device.manufacturer]
    .filter(Boolean)
    .join(" by ");
  const mapping = `${sectionName} serial ${serialPath} maps to ${device.tty} on usb ${device.usbPath}${identity ? ` (${identity})` : ""}`;
  return {
    ...finding,
    checks: [
      `Inspect ${lostMcu}'s local power, USB data path, connector, and controller; the capture-time device map identifies its kernel path.`,
      ...finding.checks.filter((check) => !check.startsWith("Confirm that kernel USB path")),
    ],
    detail: `${finding.detail} The capture-time USB serial inventory establishes that ${mapping}, tying the kernel disconnect directly to ${lostMcu}.`,
    evidence: [
      ...finding.evidence,
      {
        line: 1,
        message: mapping,
        session: finding.session,
        source: "snapshots/usb-serial-topology.json",
        time: null,
      },
    ],
  };
}
