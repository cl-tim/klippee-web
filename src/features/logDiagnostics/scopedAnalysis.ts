import { buildDiagnosticSummary } from "./summary";
import type { KlippyLogAnalysis } from "./types";

export type ScopedAnalysis = {
  findings: KlippyLogAnalysis["findings"];
  incidents: KlippyLogAnalysis["incidents"];
  lineCount: number;
  prints: KlippyLogAnalysis["prints"];
  sessions: KlippyLogAnalysis["sessions"];
  shutdownDumps: KlippyLogAnalysis["shutdownDumps"];
  summary: KlippyLogAnalysis["summary"];
};

/**
 * Narrow a full log analysis to the selected session scope. `session` is the
 * session-select value: "all" for combined results or a session number as a
 * string. Shutdown dumps are sorted newest-first regardless of scope.
 */
export function deriveScopedAnalysis(analysis: KlippyLogAnalysis, session: string): ScopedAnalysis {
  const selected = session === "all" ? null : Number(session);
  const sessions = selected === null
    ? analysis.sessions
    : analysis.sessions.filter((item) => item.number === selected);
  const findings = selected === null
    ? analysis.findings
    : analysis.findings.filter((finding) => finding.session === selected);
  const shutdownDumps = [...(selected === null
    ? analysis.shutdownDumps
    : analysis.shutdownDumps.filter((dump) => dump.session === selected))]
    .sort((left, right) => right.session - left.session || right.line - left.line);
  return {
    findings,
    incidents: selected === null
      ? analysis.incidents
      : analysis.incidents.filter((incident) => incident.session === selected),
    lineCount: selected === null
      ? analysis.lineCount
      : sessions.reduce((total, item) => total + Math.max(0, item.endLine - item.startLine + 1), 0),
    prints: selected === null
      ? analysis.prints
      : analysis.prints.filter((print) => print.session === selected),
    sessions,
    shutdownDumps,
    summary: selected === null ? analysis.summary : buildDiagnosticSummary(sessions, findings),
  };
}
