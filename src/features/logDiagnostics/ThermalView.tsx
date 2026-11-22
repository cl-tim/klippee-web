import { DiagnosticButton, DiagnosticSelect } from "./DiagnosticControls";
import { HelpRow } from "../../components/FieldHelp";
import { Thermometer } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { DiagnosticSessionCell as SessionCell } from "./DiagnosticSessionCell";
import { downsamplePoints, formatDuration, formatEventTime, numericField } from "./formatters";
import { formatSessionLabel } from "./sessionLabels";
import type { KlippyLogAnalysis, KlippySession } from "./types";

export function ThermalView({ analysis, sessions }: { analysis: KlippyLogAnalysis; sessions: KlippySession[] }) {
  const sessionCharts = sessions.flatMap((session) => {
    const series = session.sensors.flatMap((sensor, index) => {
      const points = session.samples.flatMap((sample) => {
        const fields = sample.sensors[sensor.name];
        const actual = numericField(fields?.temp);
        const target = numericField(fields?.target);
        return actual === null ? [] : [{ actual, target, time: sample.time }];
      });
      return points.length ? [{
        color: sensorColors[index % sensorColors.length],
        name: sensor.name,
        points,
      }] : [];
    });
    return series.length ? [{
      incidents: analysis.incidents.filter((incident) => incident.session === session.number && incident.time !== null),
      key: String(session.number),
      label: formatSessionLabel(analysis.sessions, session.number),
      series,
      session: session.number,
    }] : [];
  });
  const latestSession = analysis.sessions[analysis.sessions.length - 1]?.number;
  const includeBundleHistory = latestSession !== undefined && sessions.some((session) => session.number === latestSession);
  const bundleSeries = includeBundleHistory
    ? (analysis.bundle?.evidence?.thermalHistory ?? []).flatMap((sensor, index) => {
      const points = sensor.temperatures.flatMap((actual, sampleIndex) =>
        actual === null ? [] : [{
          actual,
          target: sensor.targets[sampleIndex] ?? null,
          time: sampleIndex,
        }]);
      return points.length ? [{
        color: sensorColors[index % sensorColors.length],
        name: sensor.name,
        points,
      }] : [];
    })
    : [];
  const charts = [
    ...sessionCharts,
    ...(bundleSeries.length ? [{
      incidents: [],
      key: "bundle-temperature-history",
      label: "Moonraker capture · recent 1-second history",
      series: bundleSeries,
      session: latestSession ?? 0,
    }] : []),
  ];
  const recommended = [...charts].sort((left, right) => maxChartDeviation(right.series) - maxChartDeviation(left.series))[0];
  const [selectedKey, setSelectedKey] = useState(recommended?.key ?? charts[0]?.key ?? "");
  const [hiddenSensors, setHiddenSensors] = useState<Set<string>>(() => new Set());
  const [hoveredSensor, setHoveredSensor] = useState<string | null>(null);
  const selected = charts.find((item) => item.key === selectedKey) ?? recommended ?? charts[0];

  if (!selected) return <div className="diagnostics-empty"><Thermometer size={22} /><strong>No temperature telemetry found</strong></div>;
  const visibleSeries = selected.series.filter((item) => !hiddenSensors.has(item.name));
  const displayedSeries = hoveredSensor
    ? selected.series.filter((item) => item.name === hoveredSensor)
    : visibleSeries;
  const domainSeries = hoveredSensor && hiddenSensors.has(hoveredSensor)
    ? [...visibleSeries, ...displayedSeries]
    : visibleSeries.length ? visibleSeries : displayedSeries;
  const observations = visibleSeries.reduce((total, item) => total + item.points.length, 0);
  const sensorsWithSetpoints = visibleSeries.filter((item) => item.points.some((point) => point.target !== null)).length;
  const firstTime = Math.min(...selected.series.map((item) => item.points[0].time));
  const lastTime = Math.max(...selected.series.map((item) => item.points[item.points.length - 1].time));
  const selectSession = (key: string) => {
    setSelectedKey(key);
    setHiddenSensors(new Set());
    setHoveredSensor(null);
  };
  const toggleSensor = (name: string) => {
    setHoveredSensor(null);
    setHiddenSensors((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  return <div className="diagnostics-view thermal-diagnostics">
    <div className="thermal-toolbar">
      <label>
        Temperature session
        <DiagnosticSelect aria-label="Select temperature session" onChange={(event) => selectSession(event.target.value)} value={selected.key}>
          {charts.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </DiagnosticSelect>
      </label>
      <div className="thermal-line-legend" aria-label="Line style legend"><span className="actual">Measured</span><span className="target">Setpoint</span></div>
    </div>
    <div className="thermal-chart-panel">
      <div className="thermal-chart-heading">
        <div>
          <HelpRow label="Temperature graph" help="Hover or focus a sensor to isolate it. Click its name or graph line to toggle it."><h3>{selected.label}</h3></HelpRow>
        </div>
        <span>{hoveredSensor ? `Previewing ${hoveredSensor}` : `${visibleSeries.length}/${selected.series.length} visible`}</span>
      </div>
      <div className="thermal-sensor-legend" aria-label={`${selected.label} sensor legend`}>
        {selected.series.map((item) => (
          <DiagnosticButton
            aria-pressed={!hiddenSensors.has(item.name)}
            className={`${hiddenSensors.has(item.name) ? "is-hidden" : ""}${hoveredSensor === item.name ? " is-previewing" : ""}`}
            key={item.name}
            onBlur={() => setHoveredSensor(null)}
            onClick={() => toggleSensor(item.name)}
            onFocus={() => setHoveredSensor(item.name)}
            onMouseEnter={() => setHoveredSensor(item.name)}
            onMouseLeave={() => setHoveredSensor(null)}
            style={{ "--sensor-color": item.color } as CSSProperties}
            title={`${hiddenSensors.has(item.name) ? "Show" : "Hide"} ${item.name}`}
            type="button"
          >
            {item.name}
          </DiagnosticButton>
        ))}
      </div>
      <TemperatureChart
        domainSeries={domainSeries}
        label={selected.label}
        markers={selected.incidents}
        onSensorHover={setHoveredSensor}
        onSensorToggle={toggleSensor}
        series={displayedSeries}
      />
      <div className="thermal-chart-metrics">
        <div><span>Visible sensors</span><strong>{visibleSeries.length} of {selected.series.length}</strong></div>
        <div><span>With setpoints</span><strong>{sensorsWithSetpoints}</strong></div>
        <div><span>Observations</span><strong>{observations.toLocaleString()}</strong></div>
        <div><span>Observed duration</span><strong>{formatDuration(Math.max(0, lastTime - firstTime))}</strong></div>
      </div>
    </div>
    <div className="diagnostics-table-wrap" role="region" aria-label="Temperature summary" tabIndex={0}><table className="diagnostics-table"><thead><tr><th>Session</th><th>Sensor</th><th>Minimum</th><th>Maximum</th><th>Final</th><th>Samples</th></tr></thead><tbody>
      {sessions.flatMap((session) => session.sensors.map((sensor) => <tr key={`${session.number}-${sensor.name}`}><td><SessionCell analysis={analysis} number={session.number} /></td><td><strong>{sensor.name}</strong></td><td>{sensor.minimum.toFixed(1)} °C</td><td>{sensor.maximum.toFixed(1)} °C</td><td>{sensor.final.toFixed(1)} °C</td><td>{sensor.samples.toLocaleString()}</td></tr>))}
      {includeBundleHistory && (analysis.bundle?.evidence?.thermalHistory ?? []).flatMap((sensor) => {
        const temperatures = sensor.temperatures.filter((value): value is number => value !== null);
        if (!temperatures.length) return [];
        return [<tr key={`bundle-${sensor.name}`}><td><strong>Bundle snapshot</strong><small className="diagnostics-endpoint">1-second Moonraker history</small></td><td><strong>{sensor.name}</strong></td><td>{Math.min(...temperatures).toFixed(1)} °C</td><td>{Math.max(...temperatures).toFixed(1)} °C</td><td>{temperatures[temperatures.length - 1].toFixed(1)} °C</td><td>{temperatures.length.toLocaleString()}</td></tr>];
      })}
    </tbody></table></div>
  </div>;
}

type TemperaturePoint = { actual: number; target: number | null; time: number };
type TemperatureSeries = { color: string; name: string; points: TemperaturePoint[] };

const sensorColors = [
  "#60a5fa",
  "#f59e0b",
  "#34d399",
  "#f472b6",
  "#a78bfa",
  "#fb7185",
  "#22d3ee",
  "#a3e635",
  "#f97316",
  "#e879f9",
  "#2dd4bf",
  "#facc15",
];

function TemperatureChart({ domainSeries, label, markers, onSensorHover, onSensorToggle, series }: {
  domainSeries: TemperatureSeries[];
  label: string;
  markers: KlippyLogAnalysis["incidents"];
  onSensorHover: (name: string | null) => void;
  onSensorToggle: (name: string) => void;
  series: TemperatureSeries[];
}) {
  if (!series.length) {
    return <div className="thermal-chart-empty"><Thermometer size={20} /><strong>All sensors are hidden</strong><span>Click a sensor name above to show it again.</span></div>;
  }
  const width = 960;
  const height = 300;
  const margin = { bottom: 34, left: 52, right: 18, top: 18 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = domainSeries.flatMap((item) => item.points.flatMap((point) => point.target === null ? [point.actual] : [point.actual, point.target]));
  const minimumValue = Math.min(...values);
  const maximumValue = Math.max(...values);
  const padding = Math.max(2, (maximumValue - minimumValue) * 0.08);
  const yMin = Math.floor((minimumValue - padding) / 5) * 5;
  const yMax = Math.ceil((maximumValue + padding) / 5) * 5 || yMin + 5;
  const timeMin = Math.min(...domainSeries.map((item) => item.points[0].time));
  const timeMax = Math.max(...domainSeries.map((item) => item.points[item.points.length - 1].time));
  const timeRange = Math.max(1, timeMax - timeMin);
  const x = (time: number) => margin.left + ((time - timeMin) / timeRange) * plotWidth;
  const y = (value: number) => margin.top + (1 - ((value - yMin) / Math.max(1, yMax - yMin))) * plotHeight;
  const yTicks = Array.from({ length: 5 }, (_, index) => yMin + ((yMax - yMin) * index) / 4);
  const xTicks = Array.from({ length: 5 }, (_, index) => timeMin + (timeRange * index) / 4);

  return <svg aria-label={`${label}: all measured temperatures and setpoints`} className="thermal-chart" role="group" viewBox={`0 0 ${width} ${height}`}>
    <title>{label}: all measured temperatures and setpoints</title>
    {yTicks.map((value) => <g key={`y-${value}`}><line className="chart-grid" x1={margin.left} x2={width - margin.right} y1={y(value)} y2={y(value)} /><text className="chart-axis-label" textAnchor="end" x={margin.left - 9} y={y(value) + 4}>{value.toFixed(0)}°</text></g>)}
    {xTicks.map((value) => <g key={`x-${value}`}><line className="chart-grid vertical" x1={x(value)} x2={x(value)} y1={margin.top} y2={height - margin.bottom} /><text className="chart-axis-label" textAnchor="middle" x={x(value)} y={height - 10}>{formatDuration(value - timeMin)}</text></g>)}
    {markers.flatMap((marker, index) => marker.time === null || marker.time < timeMin || marker.time > timeMax ? [] : [
      <line className={`chart-incident-marker ${marker.severity}`} key={`${marker.anchor.line}-${index}`} x1={x(marker.time)} x2={x(marker.time)} y1={margin.top} y2={height - margin.bottom}>
        <title>{`${formatEventTime(marker.time)}: ${marker.anchor.text}`}</title>
      </line>,
    ])}
    {series.map((item) => {
      const sampled = downsamplePoints(item.points, 900);
      const targetPoints = sampled.filter((point): point is TemperaturePoint & { target: number } => point.target !== null);
      const targetPath = targetPoints.map((point, index) =>
        index
          ? `H${x(point.time).toFixed(1)}V${y(point.target).toFixed(1)}`
          : `M${x(point.time).toFixed(1)},${y(point.target).toFixed(1)}`).join(" ");
      return targetPath
        ? <path className="chart-line target" d={targetPath} data-sensor={item.name} data-series-kind="setpoint" key={`${item.name}-target`} style={{ stroke: item.color }} />
        : null;
    })}
    {series.map((item) => {
      const sampled = downsamplePoints(item.points, 900);
      const actualPath = sampled.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.actual).toFixed(1)}`).join(" ");
      return <g className="sensor-chart-trace" key={`${item.name}-actual`}>
        <path
          className="chart-line actual"
          d={actualPath}
          data-sensor={item.name}
          data-series-kind="measured"
          style={{ stroke: item.color }}
        />
        <path
          aria-label={`${item.name} measured temperature; click to hide`}
          className="chart-hit-area"
          d={actualPath}
          data-sensor-hit={item.name}
          onBlur={() => onSensorHover(null)}
          onClick={() => onSensorToggle(item.name)}
          onFocus={() => onSensorHover(item.name)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSensorToggle(item.name);
            }
          }}
          onMouseEnter={() => onSensorHover(item.name)}
          onMouseLeave={() => onSensorHover(null)}
          role="button"
          tabIndex={0}
        />
      </g>;
    })}
  </svg>;
}

function maxActiveDeviation(points: TemperaturePoint[]) {
  return points.reduce((maximum, point) =>
    point.target !== null && point.target > 0 ? Math.max(maximum, Math.abs(point.target - point.actual)) : maximum, 0);
}

function maxChartDeviation(series: TemperatureSeries[]) {
  return series.reduce((maximum, item) => Math.max(maximum, maxActiveDeviation(item.points)), 0);
}
