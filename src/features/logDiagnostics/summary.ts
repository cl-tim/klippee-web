import type { DiagnosticFinding, DiagnosticSeverity, DiagnosticSummary, KlippySession } from "./types";

const severityRank: Record<DiagnosticSeverity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
const failurePriority: Record<string, number> = {
  "mcu-scheduling-latency-correlation": 0,
  "shaketune-scheduling-pressure": 0,
  "shaketune-data-timeout": 0,
  "shaketune-storage-failure": 0,
  "requested-shutdown": 0,
  "mcu-scheduling": 10,
  "heater-not-heating": 10,
  "adc-out-of-range": 10,
  "thermal-limit": 10,
  "power-reset": 10,
  "canbus-failure": 20,
  "mcu-communication-loss": 30,
  "usb-device-loss": 30,
};

export function buildDiagnosticSummary(sessions: KlippySession[], findings: DiagnosticFinding[]): DiagnosticSummary {
  const latestFirst = [...findings].sort((left, right) =>
    right.session - left.session
    || severityRank[left.severity] - severityRank[right.severity]
    || (failurePriority[left.id] ?? 50) - (failurePriority[right.id] ?? 50)
    || left.title.localeCompare(right.title));
  const explicitFailure = [...sessions].reverse().find((session) => session.shutdownReason);
  if (explicitFailure) {
    const requestedStop = latestFirst.find((item) => item.session === explicitFailure.number && item.id === "requested-shutdown");
    if (requestedStop) {
      return {
        detail: requestedStop.detail,
        findingId: requestedStop.id,
        session: requestedStop.session,
        title: "Recorded stop: emergency or remote shutdown requested",
        tone: "failure",
      };
    }
    const finding = latestFirst.find((item) => item.session === explicitFailure.number && item.severity === "critical");
    return {
      detail: finding?.detail ?? explicitFailure.shutdownReason,
      findingId: finding?.id ?? null,
      session: explicitFailure.number,
      title: finding ? `Recorded failure: ${finding.title}` : "Klipper recorded a shutdown",
      tone: "failure",
    };
  }

  const failedPrint = latestFirst.find((finding) => finding.id.startsWith("print-failed-"));
  const probeFailure = latestFirst.find((finding) => finding.id === "probe-no-trigger");
  const latestFault = latestFirst.find((finding) => finding.severity === "critical" || finding.severity === "error");
  if (probeFailure && probeFailure.session === latestFault?.session && (!failedPrint || probeFailure.session >= failedPrint.session)) {
    return {
      detail: `Klipper recorded a probing error without an explicit shutdown. ${probeFailure.detail}`,
      findingId: probeFailure.id,
      session: probeFailure.session,
      title: `Recorded failure: ${probeFailure.title}`,
      tone: "failure",
    };
  }

  const strongestClue = latestFirst.find((finding) =>
    finding.id.startsWith("heater-target-not-tracking-"))
    ?? failedPrint
    ?? latestFirst.find((finding) => finding.id === "qidi-toolchange-adapter-mismatch")
    ?? latestFirst.find((finding) => finding.severity === "critical" || finding.severity === "error");
  if (strongestClue) {
    const detail = strongestClue.id.startsWith("heater-target-not-tracking-")
      ? `No explicit Klipper shutdown was recorded before the restart. The strongest evidence from the interrupted print is: ${strongestClue.detail}`
      : strongestClue.id === "qidi-toolchange-adapter-mismatch"
      ? "No explicit Klipper shutdown or print-stop reason was recorded. However, the QIDI multi-colour adapter repeatedly tried to read a missing is_tool_change state from the loaded ToolChange extension. That indicates incompatible QIDI Box/ToolChange component versions and is the strongest software fault near the failed run."
      : `No explicit Klipper shutdown or print-stop reason was recorded. The strongest actionable clue is: ${strongestClue.detail}`;
    return {
      detail,
      findingId: strongestClue.id,
      session: strongestClue.session,
      title: `Strongest clue: ${strongestClue.title}`,
      tone: "clue",
    };
  }

  return {
    detail: "No explicit Klipper shutdown, print-stop reason, or recognized high-severity fault was recorded in this log.",
    findingId: null,
    session: sessions[sessions.length - 1]?.number ?? null,
    title: "No failure cause recorded",
    tone: "clear",
  };
}
