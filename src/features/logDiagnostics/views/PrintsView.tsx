import { FileText } from "lucide-react";
import { DiagnosticBadge } from "../DiagnosticControls";
import { formatBinaryBytes } from "../../../app/format";
import { DiagnosticSessionCell as SessionCell } from "../DiagnosticSessionCell";
import { formatEventTime } from "../formatters";
import type { KlippyLogAnalysis } from "../types";

export function PrintsView({ analysis, prints }: { analysis: KlippyLogAnalysis; prints: KlippyLogAnalysis["prints"] }) {
  if (!prints.length) {
    return <div className="diagnostics-empty"><FileText size={22} /><strong>No virtual SD prints in this scope</strong><span>The selected session scope does not contain a Starting SD card print event.</span></div>;
  }
  return <div className="diagnostics-view">
    <div className="diagnostics-table-wrap" role="region" aria-label="Print history" tabIndex={0}><table className="diagnostics-table"><thead><tr><th>Session</th><th>File</th><th>Outcome</th><th>Progress</th><th>Started</th><th>Ended</th><th>Reason</th></tr></thead><tbody>
      {prints.map((print, index) => <tr key={`${print.session}-${print.startLine}-${index}`}>
        <td><SessionCell analysis={analysis} number={print.session} /></td>
        <td><strong>{print.fileName}</strong><small className="diagnostics-endpoint">{print.fileSize === null ? "Size not recorded" : formatBinaryBytes(print.fileSize)}</small></td>
        <td><DiagnosticBadge className={`print-outcome ${print.outcome}`} variant="light">{print.outcome}</DiagnosticBadge></td>
        <td>{print.progress === null ? "Unknown" : `${(print.progress * 100).toFixed(1)}%`}</td>
        <td>Line {print.startLine}<small className="diagnostics-endpoint">{formatEventTime(print.startTime)}</small></td>
        <td>{print.endLine === null ? "Not recorded" : <>Line {print.endLine}<small className="diagnostics-endpoint">{formatEventTime(print.endTime)}</small></>}</td>
        <td>{print.reason || "No final outcome was recorded."}</td>
      </tr>)}
    </tbody></table></div>
  </div>;
}
