import { describeSession } from "./sessionLabels";
import type { KlippyLogAnalysis } from "./types";

export function DiagnosticSessionCell({
  analysis,
  number,
}: {
  analysis: KlippyLogAnalysis;
  number: number;
}) {
  const description = describeSession(analysis.sessions, number);
  return (
    <span className="diagnostics-session-cell">
      <strong>Session {number}</strong>
      {description && <small>{description}</small>}
    </span>
  );
}
