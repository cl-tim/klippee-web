import { DiagnosticSelect } from "../DiagnosticControls";
import { GitCompare } from "lucide-react";
import { useState } from "react";
import { formatMemory, formatOptional } from "../formatters";
import { formatSessionLabel } from "../sessionLabels";
import type { KlippyLogAnalysis } from "../types";

export function ComparisonView({ analysis }: { analysis: KlippyLogAnalysis }) {
  const [leftNumber, setLeftNumber] = useState(analysis.sessions[0]?.number ?? 0);
  const [rightNumber, setRightNumber] = useState(analysis.sessions[analysis.sessions.length - 1]?.number ?? 0);
  if (analysis.sessions.length < 2) return <div className="diagnostics-empty"><GitCompare size={22} /><strong>At least two sessions are required</strong><span>Add another klippy log or a log containing multiple printer starts.</span></div>;
  const left = analysis.sessions.find((session) => session.number === leftNumber) ?? analysis.sessions[0];
  const right = analysis.sessions.find((session) => session.number === rightNumber) ?? analysis.sessions[analysis.sessions.length - 1];
  const rows = [
    ["Source", left.source, right.source],
    ["Klipper version", left.klipperVersion || "Not recorded", right.klipperVersion || "Not recorded"],
    ["Shutdown", left.shutdownReason || "None recorded", right.shutdownReason || "None recorded"],
    ["Print outcomes", summarizePrints(left.prints), summarizePrints(right.prints)],
    ["Maximum host load", formatOptional(left.host.maxSystemLoad), formatOptional(right.host.maxSystemLoad)],
    ["Minimum available memory", formatMemory(left.host.minAvailableMemoryMib), formatMemory(right.host.minAvailableMemoryMib)],
    ["MCUs", left.mcus.map((mcu) => mcu.name).join(", ") || "None", right.mcus.map((mcu) => mcu.name).join(", ") || "None"],
    ["Retransmitted bytes", String(left.mcus.reduce((total, mcu) => total + mcu.retransmittedBytesDelta, 0)), String(right.mcus.reduce((total, mcu) => total + mcu.retransmittedBytesDelta, 0))],
    ["Invalid bytes", String(left.mcus.reduce((total, mcu) => total + mcu.invalidBytesDelta, 0)), String(right.mcus.reduce((total, mcu) => total + mcu.invalidBytesDelta, 0))],
    ["Sensors", left.sensors.map((sensor) => sensor.name).join(", ") || "None", right.sensors.map((sensor) => sensor.name).join(", ") || "None"],
  ];
  return <div className="diagnostics-view comparison-view">
    <div className="comparison-selectors">
      <label>Baseline session<DiagnosticSelect aria-label="Select baseline session" onChange={(event) => setLeftNumber(Number(event.target.value))} value={left.number}>{analysis.sessions.map((session) => <option key={session.number} value={session.number}>{formatSessionLabel(analysis.sessions, session.number)}</option>)}</DiagnosticSelect></label>
      <label>Comparison session<DiagnosticSelect aria-label="Select comparison session" onChange={(event) => setRightNumber(Number(event.target.value))} value={right.number}>{analysis.sessions.map((session) => <option key={session.number} value={session.number}>{formatSessionLabel(analysis.sessions, session.number)}</option>)}</DiagnosticSelect></label>
    </div>
    <div className="diagnostics-table-wrap" role="region" aria-label="Session comparison" tabIndex={0}><table className="diagnostics-table comparison-table"><thead><tr><th>Signal</th><th>{formatSessionLabel(analysis.sessions, left.number)}</th><th>{formatSessionLabel(analysis.sessions, right.number)}</th></tr></thead><tbody>{rows.map(([label, leftValue, rightValue]) => <tr className={leftValue === rightValue ? "" : "is-different"} key={label}><th>{label}</th><td>{leftValue}</td><td>{rightValue}</td></tr>)}</tbody></table></div>
  </div>;
}

function summarizePrints(prints: KlippyLogAnalysis["prints"]) {
  if (!prints.length) return "None detected";
  const counts = new Map<string, number>();
  for (const print of prints) counts.set(print.outcome, (counts.get(print.outcome) ?? 0) + 1);
  return [...counts].map(([outcome, count]) => `${count} ${outcome}`).join(", ");
}
