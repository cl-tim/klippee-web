import { DiagnosticButton } from "../DiagnosticControls";
import { Affix, Paper } from "@mantine/core";
import { formatBinaryBytes } from "../../../app/format";
import type { AnalysisProgress } from "../fileAnalyzer";

export function AnalysisProgressBar({ onCancel, progress }: { onCancel: () => void; progress: AnalysisProgress }) {
  const percentage = Math.min(100, progress.totalBytes ? (progress.processedBytes / progress.totalBytes) * 100 : 0);
  return <Affix position={{ bottom: 16, right: 16 }} zIndex={100}><Paper className="diagnostics-progress" role="status" shadow="md" withBorder>
    <div><span style={{ width: `${percentage}%` }} /></div>
    <p>File {progress.fileIndex + 1} of {progress.fileTotal}: {progress.fileName} · {formatBinaryBytes(progress.processedBytes)} of {formatBinaryBytes(progress.totalBytes)}</p>
    <DiagnosticButton className="secondary-action" onClick={onCancel} type="button">Cancel</DiagnosticButton>
  </Paper></Affix>;
}
