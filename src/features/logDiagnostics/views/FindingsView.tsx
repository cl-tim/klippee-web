import { ShieldCheck } from "lucide-react";
import { formatEventTime } from "../formatters";
import { formatSessionLabel } from "../sessionLabels";
import type { KlippyLogAnalysis } from "../types";

export function FindingsView({ analysis, findings, summary }: {
  analysis: KlippyLogAnalysis;
  findings: KlippyLogAnalysis["findings"];
  summary: KlippyLogAnalysis["summary"];
}) {
  return <div className="diagnostics-findings-wrap">
    <section className={`diagnostics-conclusion ${summary.tone}`} aria-labelledby="diagnostics-conclusion-title">
      <span>{summary.tone === "failure" ? "Recorded outcome" : summary.tone === "clue" ? "What this session can tell us" : "Analysis result"}</span>
      <h2 id="diagnostics-conclusion-title">{summary.title}</h2>
      <p>{summary.detail}</p>
      {summary.session !== null && <small>Evidence is in {formatSessionLabel(analysis.sessions, summary.session)}. Findings below retain the exact log lines and checks.</small>}
    </section>
    {!findings.length
      ? <div className="diagnostics-empty"><ShieldCheck size={22} /><strong>No recognized failures in this scope</strong><span>The timeline remains available for manual review.</span></div>
      : <div className="diagnostics-findings">{findings.map((finding, index) => (
    <details className={`diagnostic-finding ${finding.severity}`} key={`${finding.session}-${finding.id}-${index}`} open={index < 3}>
      <summary>
        <span className={`finding-mark ${finding.severity}`}></span>
        <span><strong>{finding.title}</strong><small>{finding.family} | {formatSessionLabel(analysis.sessions, finding.session)}</small></span>
        <span className="finding-confidence">{finding.confidence}</span>
      </summary>
      <div className="finding-detail">
        <p>{finding.detail}</p>
        {finding.evidence.length > 0 && <div className="finding-evidence">{finding.evidence.map((evidence) => <div key={`${evidence.line}-${evidence.message}`}><span>Line {evidence.line} | {formatEventTime(evidence.time)}</span><code>{evidence.message}</code></div>)}</div>}
        <div><h3>Checks</h3><ul>{finding.checks.map((check) => <li key={check}>{check}</li>)}</ul></div>
      </div>
    </details>
      ))}</div>}
  </div>;
}
