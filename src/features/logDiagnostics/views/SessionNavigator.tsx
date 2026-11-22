import { DiagnosticButton, DiagnosticSelect } from "../DiagnosticControls";
import { formatSessionLabel } from "../sessionLabels";
import type { KlippyLogAnalysis } from "../types";

export function SessionNavigator({ analysis, onChange, value }: {
  analysis: KlippyLogAnalysis;
  onChange: (value: string) => void;
  value: string;
}) {
  const selectedNumber = value === "all" ? null : Number(value);
  const selectedIndex = selectedNumber === null
    ? -1
    : analysis.sessions.findIndex((session) => session.number === selectedNumber);
  const older = selectedIndex > 0 ? analysis.sessions[selectedIndex - 1] : null;
  const newer = selectedIndex >= 0 && selectedIndex < analysis.sessions.length - 1
    ? analysis.sessions[selectedIndex + 1]
    : null;
  const selected = selectedIndex >= 0 ? analysis.sessions[selectedIndex] : null;
  // From the combined scope, "Previous session" steps into the newest session —
  // the most common starting point — instead of leaving both buttons disabled.
  const newest = analysis.sessions[analysis.sessions.length - 1] ?? null;
  const previousTarget = selectedNumber === null ? newest : older;
  const latestFirst = [...analysis.sessions].reverse();
  return <section className="diagnostics-session-scope" aria-labelledby="diagnostics-session-title">
    <div>
      <span>Session scope</span>
      <strong id="diagnostics-session-title">
        {selected ? formatSessionLabel(analysis.sessions, selected.number) : "All sessions combined"}
      </strong>
      <small>
        {selected
          ? `Showing only this session from ${selected.source}, lines ${selected.startLine.toLocaleString()}–${selected.endLine.toLocaleString()}.`
          : "Showing combined results from every detected session."}
      </small>
    </div>
    <label>
      View session
      <DiagnosticSelect aria-label="Select diagnostic session" onChange={(event) => onChange(event.target.value)} value={value}>
        {latestFirst.map((session) => (
          <option key={session.number} value={session.number}>{formatSessionLabel(analysis.sessions, session.number)}</option>
        ))}
        <option value="all">All sessions combined</option>
      </DiagnosticSelect>
    </label>
    <div className="diagnostics-session-actions">
      <DiagnosticButton className="secondary-action" disabled={!previousTarget} onClick={() => previousTarget && onChange(String(previousTarget.number))} type="button">Previous session</DiagnosticButton>
      <DiagnosticButton className="secondary-action" disabled={!newer} onClick={() => newer && onChange(String(newer.number))} type="button">Next session</DiagnosticButton>
    </div>
  </section>;
}
