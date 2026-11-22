import { DiagnosticBadge, DiagnosticButton, DiagnosticSelect, DiagnosticInput } from "../DiagnosticControls";
import { Search } from "lucide-react";
import { useState } from "react";
import { DiagnosticSessionCell as SessionCell } from "../DiagnosticSessionCell";
import { formatEventTime } from "../formatters";
import type { DiagnosticSeverity, KlippyLogAnalysis } from "../types";

export function TimelineView({ analysis, events, query, setQuery, setSeverity, severity }: {
  analysis: KlippyLogAnalysis;
  events: KlippyLogAnalysis["events"];
  query: string;
  setQuery: (value: string) => void;
  setSeverity: (value: DiagnosticSeverity | "all") => void;
  severity: DiagnosticSeverity | "all";
}) {
  const [limit, setLimit] = useState(250);
  const visibleEvents = events.slice(0, limit);
  return <div className="diagnostics-view">
    <div className="timeline-toolbar">
      <label><Search size={14} /><DiagnosticInput aria-label="Search timeline" onChange={(event) => setQuery(event.target.value)} placeholder="Search events" type="search" value={query} /></label>
      <DiagnosticSelect aria-label="Filter severity" onChange={(event) => setSeverity(event.target.value as DiagnosticSeverity | "all")} value={severity}><option value="all">All severities</option><option value="critical">Critical</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Information</option></DiagnosticSelect>
    </div>
    <div className="diagnostics-table-wrap" role="region" aria-label="Diagnostic timeline" tabIndex={0}><table className="diagnostics-table"><thead><tr><th>Severity</th><th>Source</th><th>Session</th><th>Time</th><th>Line(s)</th><th>Category</th><th>Event</th><th>Count</th></tr></thead><tbody>{visibleEvents.map((event) => <tr key={`${event.source}-${event.session}-${event.firstLine}-${event.message}`}><td><DiagnosticBadge className={`timeline-severity ${event.severity}`} variant="light">{event.severity}</DiagnosticBadge></td><td>{event.source}</td><td><SessionCell analysis={analysis} number={event.session} /></td><td>{formatEventTime(event.firstTime)}</td><td>{event.firstLine === event.lastLine ? event.firstLine : `${event.firstLine}-${event.lastLine}`}</td><td>{event.category}</td><td><code>{event.message}</code></td><td>{event.count.toLocaleString()}</td></tr>)}</tbody></table>{events.length === 0 && <div className="diagnostics-empty"><span>No events match the current filters.</span></div>}</div>
    {events.length > visibleEvents.length && <DiagnosticButton className="secondary-action diagnostics-load-more" onClick={() => setLimit((current) => current + 250)} type="button">Show 250 more events</DiagnosticButton>}
  </div>;
}
