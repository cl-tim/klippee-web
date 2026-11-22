import { DiagnosticButton } from "../DiagnosticControls";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { formatSessionLabel } from "../sessionLabels";
import type { KlippyLogAnalysis } from "../types";

export function IncidentsView({ analysis, incidents: allIncidents }: {
  analysis: KlippyLogAnalysis;
  incidents: KlippyLogAnalysis["incidents"];
}) {
  const [limit, setLimit] = useState(50);
  const incidents = allIncidents.slice(0, limit);
  if (!incidents.length) return <div className="diagnostics-empty"><ShieldCheck size={22} /><strong>No error incidents in this scope</strong><span>Warnings and informational events remain available in the timeline.</span></div>;
  return <div className="diagnostics-view incident-list">
    {incidents.map((incident, index) => <details className={`diagnostic-incident ${incident.severity}`} key={`${incident.source}-${incident.anchor.line}-${index}`} open={index === 0}>
      <summary>
        <span className={`finding-mark ${incident.severity}`} />
        <span><strong>{incident.anchor.text}</strong><small>{incident.source} · {formatSessionLabel(analysis.sessions, incident.session)} · line {incident.anchor.line}</small></span>
      </summary>
      <div className="incident-body">
        {incident.commandContext.length > 0 && <section><h3>G-code and virtual SD context</h3>{incident.commandContext.map((line, lineIndex) => <code key={`${lineIndex}-${line}`}>{line}</code>)}</section>}
        <section><h3>Surrounding log lines</h3>
          {[...incident.before, incident.anchor, ...incident.after].map((line, lineIndex) => <div className={line.line === incident.anchor.line && line.text === incident.anchor.text ? "incident-line anchor" : "incident-line"} key={`${line.line}-${lineIndex}`}><span>{line.line}</span><code>{line.text}</code></div>)}
        </section>
      </div>
    </details>)}
    {allIncidents.length > incidents.length && <DiagnosticButton className="secondary-action diagnostics-load-more" onClick={() => setLimit((current) => current + 50)} type="button">Show 50 more incidents</DiagnosticButton>}
  </div>;
}
