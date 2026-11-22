import { Database } from "lucide-react";
import { DiagnosticBadge } from "../DiagnosticControls";
import { formatDuration, formatWallTime } from "../formatters";
import type { KlippyLogAnalysis } from "../types";

export function SnapshotView({ analysis }: { analysis: KlippyLogAnalysis }) {
  const evidence = analysis.bundle?.evidence;
  if (!evidence) {
    return <div className="diagnostics-empty">
      <Database size={22} />
      <strong>No structured runtime snapshot found</strong>
    </div>;
  }
  const captureTime = analysis.bundle?.generatedAt
    ? new Date(analysis.bundle.generatedAt).toLocaleString()
    : "the bundle capture time";
  return <div className="diagnostics-view bundle-evidence-view" style={{ minWidth: 0, width: "100%" }}>
    <div className="bundle-evidence-callout">
      <Database size={20} />
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}><strong>Capture-time evidence</strong>These values were recorded at {captureTime}, after the newest log session. They do not change when you select an older session.</span>
    </div>
    <div className="bundle-evidence-grid">
      <article>
        <span>Klipper</span>
        <strong>{evidence.printer?.state || evidence.server?.klippyState || "State unavailable"}</strong>
        <p>{evidence.printer?.message || "No state message was returned."}</p>
        <small>{evidence.printer?.softwareVersion || "Version unavailable"}</small>
      </article>
      <article>
        <span>Moonraker</span>
        <strong>{evidence.server?.klippyConnected === null || evidence.server?.klippyConnected === undefined ? "Connection unknown" : evidence.server.klippyConnected ? "Connected to Klipper" : "Disconnected from Klipper"}</strong>
        <p>{evidence.server?.failedComponents.length ?? 0} failed components · {evidence.server?.warnings.length ?? 0} warnings</p>
        <small>{evidence.server?.moonrakerVersion || "Version unavailable"}</small>
      </article>
      <article>
        <span>Print at capture</span>
        <strong>{evidence.print?.state || "No print state"}</strong>
        <p>{evidence.print?.filename || evidence.print?.message || "No active filename was returned."}</p>
        <small>{evidence.print?.progress === null || evidence.print?.progress === undefined ? "Progress unavailable" : `${(evidence.print.progress * 100).toFixed(1)}% · ${formatDuration(evidence.print.printDuration)} printing`}</small>
      </article>
      <article>
        <span>Captured context</span>
        <strong>{evidence.objectCount} printer objects</strong>
        <p>{evidence.sensors.length} live sensors · {evidence.thermalHistory.length} temperature histories</p>
        <small>{evidence.gcode.length} G-code entries · {evidence.jobs.length} jobs · {evidence.config?.retainedSectionCount ?? 0} config sections{evidence.hostScheduling ? " · host scheduling captured" : ""}{evidence.usbSerialDevices.length ? ` · ${evidence.usbSerialDevices.length} USB serial devices` : ""}</small>
      </article>
    </div>
    {(evidence.server?.warnings.length || evidence.server?.failedComponents.length || evidence.parseWarnings.length) ? <section className="bundle-evidence-warnings">
      <h3>Snapshot warnings</h3>
      <ul>
        {evidence.server?.failedComponents.map((component) => <li key={`component-${component}`}><strong>Failed component:</strong> {component}</li>)}
        {evidence.server?.warnings.map((warning, index) => <li key={`warning-${index}`}>{warning}</li>)}
        {evidence.parseWarnings.map((warning, index) => <li key={`parse-${index}`}>{warning}</li>)}
      </ul>
    </section> : null}
    {evidence.hostScheduling && <section>
      <h3>Host scheduling at capture</h3>
      <p>Online CPUs: <code>{evidence.hostScheduling.onlineCpus || "Unavailable"}</code> · irqbalance: <code>{evidence.hostScheduling.irqbalanceState || "Unavailable"}</code> · ondemand service: <code>{evidence.hostScheduling.ondemandState || "Unavailable"}</code></p>
      <div className="diagnostics-table-wrap" role="region" aria-label="Host scheduling at capture" tabIndex={0} style={{ minWidth: 0, width: "100%" }}><table className="diagnostics-table">
        <thead><tr><th>Kind</th><th>Name</th><th>Requested / configured CPUs</th><th>Effective / runtime CPUs</th><th>State</th></tr></thead>
        <tbody>
          {Object.entries(evidence.hostScheduling.governors).map(([policy, governor]) => <tr key={`governor-${policy}`}><td>CPU policy</td><td>{policy}</td><td>Governor</td><td>{governor}</td><td /></tr>)}
          {evidence.hostScheduling.serialIrqs.map((irq) => <tr key={`irq-${irq.device}-${irq.irq}`}><td>Serial IRQ {irq.irq}</td><td>{irq.device}</td><td>{irq.requestedCpuList || "Unavailable"}</td><td>{irq.effectiveCpuList || "Unavailable"}</td><td /></tr>)}
          {evidence.hostScheduling.services.map((service) => <tr key={`service-${service.name}`}><td>Service</td><td>{service.name}</td><td>{service.cpuAffinity || "Default"}</td><td>{service.cpuAllowedList || "Unavailable"}</td><td>{service.activeState || "Unavailable"}</td></tr>)}
        </tbody>
      </table></div>
    </section>}
    {evidence.usbSerialDevices.length > 0 && <section>
      <h3>USB serial topology at capture</h3>
      <div className="diagnostics-table-wrap" role="region" aria-label="USB serial topology at capture" tabIndex={0} style={{ minWidth: 0, width: "100%" }}><table className="diagnostics-table">
        <thead><tr><th>Stable serial path</th><th>TTY</th><th>Kernel USB path</th><th>Device</th></tr></thead>
        <tbody>{evidence.usbSerialDevices.map((device) => <tr key={`${device.byId}-${device.usbPath}`}>
          <td><code>{device.byId}</code></td>
          <td><code>{device.tty}</code></td>
          <td><code>{device.usbPath}</code></td>
          <td>{device.product || device.manufacturer || `${device.vendorId}:${device.productId}`}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    {evidence.sensors.length > 0 && <section>
      <h3>Live sensor state at capture</h3>
      <div className="diagnostics-table-wrap" role="region" aria-label="Live sensor state at capture" tabIndex={0} style={{ minWidth: 0, width: "100%" }}><table className="diagnostics-table">
        <thead><tr><th>Sensor</th><th>Temperature</th><th>Target</th><th>Power</th></tr></thead>
        <tbody>{evidence.sensors.map((sensor) => <tr key={sensor.name}>
          <td><strong>{sensor.name}</strong></td>
          <td>{sensor.temperature.toFixed(1)} °C</td>
          <td>{sensor.target === null ? "Not reported" : `${sensor.target.toFixed(1)} °C`}</td>
          <td>{sensor.power === null ? "Not reported" : `${(sensor.power * 100).toFixed(0)}%`}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    {evidence.jobs.length > 0 && <section>
      <h3>Recent Moonraker jobs</h3>
      <div className="diagnostics-table-wrap" role="region" aria-label="Recent Moonraker jobs" tabIndex={0} style={{ minWidth: 0, width: "100%" }}><table className="diagnostics-table">
        <thead><tr><th>File</th><th>Outcome</th><th>Started</th><th>Ended</th><th>Print time</th><th>Total time</th></tr></thead>
        <tbody>{evidence.jobs.map((job, index) => <tr key={`${job.startTime}-${job.filename}-${index}`}>
          <td><strong>{job.filename || "Filename unavailable"}</strong></td>
          <td><DiagnosticBadge className={`print-outcome ${job.status}`} variant="light">{job.status.replace(/_/g, " ")}</DiagnosticBadge></td>
          <td>{formatWallTime(job.startTime)}</td>
          <td>{formatWallTime(job.endTime)}</td>
          <td>{formatDuration(job.printDuration)}</td>
          <td>{formatDuration(job.totalDuration)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    {evidence.gcode.length > 0 && <details className="bundle-gcode-context" style={{ minWidth: 0, width: "100%" }}>
      <summary style={{ overflowWrap: "anywhere" }}>Recent Moonraker G-code context ({evidence.gcode.length})</summary>
      <div>{[...evidence.gcode].reverse().map((entry, index) => <code key={`${entry.time}-${index}`}><span>{formatWallTime(entry.time)} · {entry.type || "message"}</span>{entry.message}</code>)}</div>
    </details>}
  </div>;
}
