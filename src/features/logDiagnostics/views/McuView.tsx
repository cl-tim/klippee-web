import { DiagnosticBadge, DiagnosticSelect } from "../DiagnosticControls";
import { useState, type CSSProperties } from "react";
import { DiagnosticSessionCell as SessionCell } from "../DiagnosticSessionCell";
import { downsamplePoints, numericField, signed } from "../formatters";
import { formatSessionLabel } from "../sessionLabels";
import type { KlippyLogAnalysis, KlippySession } from "../types";

export function McuView({ analysis, sessions }: { analysis: KlippyLogAnalysis; sessions: KlippySession[] }) {
  const choices = sessions.flatMap((session) => session.mcus.map((mcu) => ({
    key: `${session.number}:${mcu.name}`,
    label: `${formatSessionLabel(analysis.sessions, session.number)} · ${mcu.name}`,
    mcu,
    session,
  })));
  const [selectedKey, setSelectedKey] = useState(choices[0]?.key ?? "");
  const selected = choices.find((choice) => choice.key === selectedKey) ?? choices[0];
  return <div className="diagnostics-view mcu-diagnostics">
    {selected && <div className="mcu-trend-panel">
      <label>MCU trend<DiagnosticSelect aria-label="Select MCU trend" onChange={(event) => setSelectedKey(event.target.value)} value={selected.key}>{choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</DiagnosticSelect></label>
      <McuTrendChart name={selected.mcu.name} samples={selected.session.samples} />
    </div>}
    <div className="diagnostics-table-wrap" role="region" aria-label="MCU statistics" tabIndex={0}><table className="diagnostics-table"><thead><tr><th>Session</th><th>MCU / endpoint</th><th>Samples</th><th>Retransmit before / after shutdown</th><th>Invalid before / after shutdown</th><th>Final lag</th><th>Max lag</th><th>Max queued</th><th>End state</th></tr></thead><tbody>{sessions.flatMap((session) => session.mcus.map((mcu) => <tr key={`${session.number}-${mcu.name}`}><td><SessionCell analysis={analysis} number={session.number} /></td><td><strong>{mcu.name}</strong><small className="diagnostics-endpoint">{mcu.serialPath || "Endpoint not captured"}</small></td><td>{mcu.samples.toLocaleString()}</td><td>{signed(mcu.preShutdownRetransmittedBytesDelta)} / {signed(mcu.postShutdownRetransmittedBytesDelta)}</td><td>{signed(mcu.preShutdownInvalidBytesDelta)} / {signed(mcu.postShutdownInvalidBytesDelta)}</td><td>{mcu.finalSequenceLag}</td><td>{mcu.maxSequenceLag}</td><td>{mcu.maxQueuedBytes.toLocaleString()}</td><td><DiagnosticBadge className={mcu.stalledForSeconds >= 3 ? "mcu-state stalled" : "mcu-state active"} variant="light">{mcu.stalledForSeconds >= 3 ? "Stalled" : "Active"}</DiagnosticBadge> {mcu.stalledForSeconds.toFixed(1)}s</td></tr>))}</tbody></table></div>
  </div>;
}

function McuTrendChart({ name, samples }: { name: string; samples: KlippyLogAnalysis["sessions"][number]["samples"] }) {
  const points = samples.flatMap((sample) => {
    const fields = sample.mcus[name];
    if (!fields) return [];
    return [{
      invalid: numericField(fields.bytes_invalid) ?? 0,
      lag: Math.max(0, (numericField(fields.send_seq) ?? 0) - (numericField(fields.receive_seq) ?? 0)),
      queued: numericField(fields.upcoming_bytes) ?? 0,
      retransmit: numericField(fields.bytes_retransmit) ?? 0,
      time: sample.time,
    }];
  });
  if (points.length < 2) return <div className="diagnostics-empty"><span>Not enough MCU telemetry to graph.</span></div>;
  const sampled = downsamplePoints(points, 900);
  const width = 960;
  const height = 220;
  const margin = 24;
  const firstTime = sampled[0].time;
  const timeRange = Math.max(1, sampled[sampled.length - 1].time - firstTime);
  const x = (time: number) => margin + ((time - firstTime) / timeRange) * (width - margin * 2);
  // Each series is normalized to its own peak so shapes stay readable, so the
  // legend carries the real per-series maximum to keep magnitudes comparable.
  const series = ([
    { color: "#67e8f9", key: "retransmit", label: "Retransmitted bytes" },
    { color: "#fb7185", key: "invalid", label: "Invalid bytes" },
    { color: "#facc15", key: "lag", label: "Sequence lag" },
    { color: "#a78bfa", key: "queued", label: "Queued bytes" },
  ] as const).map((item) => ({
    ...item,
    peak: Math.max(...sampled.map((point) => point[item.key])),
  }));
  return <div className="mcu-trend-chart">
    <div className="mcu-trend-legend">{series.map((item) => <span key={item.key} style={{ "--sensor-color": item.color } as CSSProperties}>{item.label} (max {item.peak.toLocaleString()})</span>)}</div>
    <svg aria-label={`${name} communication counters over time`} role="img" viewBox={`0 0 ${width} ${height}`}>
      {series.map((item) => {
        const maximum = Math.max(1, item.peak);
        const path = sampled.map((point, index) => {
          const y = height - margin - (point[item.key] / maximum) * (height - margin * 2);
          return `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
        return <path d={path} key={item.key} style={{ stroke: item.color }} />;
      })}
    </svg>
  </div>;
}
