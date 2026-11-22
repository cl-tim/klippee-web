import { formatBinaryBytes } from "../../../app/format";
import type { KlippyLogAnalysis } from "../types";

export function AnalysisScope({ analysis }: { analysis: KlippyLogAnalysis }) {
  const dropped = Object.values(analysis.truncation).reduce((total, value) => total + value, 0);
  const safeguardDetails = [
    analysis.truncation.droppedSamples > 0 ? `${analysis.truncation.droppedSamples.toLocaleString()} telemetry samples compacted` : "",
    analysis.truncation.droppedEvents > 0 ? `${analysis.truncation.droppedEvents.toLocaleString()} unique events omitted` : "",
    analysis.truncation.droppedIncidentContexts > 0 ? `${analysis.truncation.droppedIncidentContexts.toLocaleString()} incident contexts omitted` : "",
    analysis.truncation.droppedShutdownMessages > 0 ? `${analysis.truncation.droppedShutdownMessages.toLocaleString()} shutdown queue messages omitted` : "",
    analysis.truncation.droppedShutdownDumps > 0 ? `${analysis.truncation.droppedShutdownDumps.toLocaleString()} shutdown dumps omitted` : "",
    analysis.truncation.droppedMcuNames > 0 ? `${analysis.truncation.droppedMcuNames.toLocaleString()} MCU names omitted` : "",
    analysis.truncation.droppedSensorNames > 0 ? `${analysis.truncation.droppedSensorNames.toLocaleString()} sensor names omitted` : "",
    analysis.truncation.longLines > 0 ? `${analysis.truncation.longLines.toLocaleString()} oversized lines truncated` : "",
  ].filter(Boolean);
  return <div className="diagnostics-scope">
    {analysis.bundle && <div className="diagnostics-bundle-summary">
      <strong>Diagnostic bundle v{analysis.bundle.schemaVersion}</strong>
      <span>
        {analysis.bundle.artifacts.length} artifacts
        {analysis.bundle.clientVersion ? ` · CLI ${analysis.bundle.clientVersion}` : ""}
        {analysis.bundle.generatedAt ? ` · captured ${new Date(analysis.bundle.generatedAt).toLocaleString()}` : ""}
      </span>
      {analysis.bundle.collectionWarnings.length > 0 && <small>
        Missing evidence: {analysis.bundle.collectionWarnings.join(" ")}
      </small>}
      <details>
        <summary>Review captured evidence</summary>
        <ul>
          {analysis.bundle.artifacts.map((artifact) => <li key={artifact.archiveName}>
            <span><strong>{artifact.archiveName}</strong>{artifact.kind}</span>
            <span>{formatBinaryBytes(artifact.storedSizeBytes)}{artifact.truncated ? " · newest data only" : ""}</span>
          </li>)}
        </ul>
      </details>
    </div>}
    <div className="diagnostics-source-list">
      {analysis.sources.map((source) => <span key={source.name}><strong>{source.name}</strong>{source.kind} · {source.lineCount.toLocaleString()} lines{source.compressed ? " · gzip" : ""}</span>)}
      {analysis.vendors.map((vendor) => <span className="vendor-profile" key={vendor.id}><strong>{vendor.name}</strong>detected</span>)}
    </div>
    {dropped > 0 && <div className="diagnostics-compaction" role="status">
      <strong>Large-log safeguards were applied</strong>
      <span>{safeguardDetails.join(" · ")}</span>
    </div>}
  </div>;
}
