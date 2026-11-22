import type {
  DiagnosticBundleEvidence,
  DiagnosticBundleGcodeEntry,
  DiagnosticBundleJob,
  DiagnosticBundleSensor,
  DiagnosticBundleThermalSeries,
  DiagnosticFinding,
  DiagnosticSeverity,
} from "./types";
import {
  buildDiagnosticConfigFindings,
  parseDiagnosticConfigEvidence,
} from "./diagnosticConfigEvidence";

const maximumSnapshotArrayLength = 3_600;
const maximumSnapshotStrings = 100;

export function parseDiagnosticBundleEvidence(
  snapshots: Map<string, string>,
  ingestionWarnings: string[] = [],
): DiagnosticBundleEvidence | null {
  const parseWarnings = [...ingestionWarnings];
  const read = (name: string) => parseSnapshot(snapshots.get(name), name, parseWarnings);
  const serverPayload = resultRecord(read("snapshots/server-info.json"));
  const printerPayload = resultRecord(read("snapshots/printer-info.json"));
  const objectPayload = resultRecord(read("snapshots/printer-objects.json"));
  const objectStatus = recordValue(objectPayload?.status);
  const config = parseDiagnosticConfigEvidence(objectStatus?.configfile);
  const hostSchedulingPayload = recordValue(read("snapshots/host-scheduling.json"));
  const temperaturePayload = resultRecord(read("snapshots/temperature-store.json"));
  const gcodePayload = resultRecord(read("snapshots/gcode-store.json"));
  const historyPayload = resultRecord(read("snapshots/job-history.json"));
  const usbSerialPayload = recordValue(read("snapshots/usb-serial-topology.json"));

  const server = serverPayload ? {
    failedComponents: stringArray(serverPayload.failed_components),
    klippyConnected: booleanValue(serverPayload.klippy_connected),
    klippyState: stringValue(serverPayload.klippy_state),
    moonrakerVersion: stringValue(serverPayload.moonraker_version),
    warnings: stringArray(serverPayload.warnings),
  } : null;
  const printer = printerPayload ? {
    message: stringValue(printerPayload.state_message),
    softwareVersion: stringValue(printerPayload.software_version),
    state: stringValue(printerPayload.state),
  } : null;
  const printStats = recordValue(objectStatus?.print_stats);
  const virtualSd = recordValue(objectStatus?.virtual_sdcard);
  const print = printStats ? {
    filename: stringValue(printStats.filename),
    message: stringValue(printStats.message),
    printDuration: numberValue(printStats.print_duration) ?? 0,
    progress: numberValue(virtualSd?.progress)
      ?? ratio(numberValue(virtualSd?.file_position), numberValue(virtualSd?.file_size)),
    state: stringValue(printStats.state),
    totalDuration: numberValue(printStats.total_duration) ?? 0,
  } : null;
  const sensors = objectStatus ? parseRuntimeSensors(objectStatus) : [];
  const thermalHistory = temperaturePayload ? parseThermalHistory(temperaturePayload) : [];
  const gcode = parseGcode(gcodePayload);
  const jobs = parseJobs(historyPayload);
  const hostScheduling = parseHostScheduling(hostSchedulingPayload);
  const usbSerialDevices = parseUsbSerialDevices(usbSerialPayload);

  if (
    !config
    && !hostScheduling
    && !server
    && !printer
    && !print
    && !objectStatus
    && !thermalHistory.length
    && !gcode.length
    && !jobs.length
    && !usbSerialDevices.length
    && !parseWarnings.length
  ) return null;
  return {
    config,
    gcode,
    hostScheduling,
    jobs,
    objectCount: objectStatus ? Object.keys(objectStatus).length : 0,
    parseWarnings,
    print,
    printer,
    sensors,
    server,
    thermalHistory,
    usbSerialDevices,
  };
}

function parseUsbSerialDevices(
  payload: Record<string, unknown> | null,
): DiagnosticBundleEvidence["usbSerialDevices"] {
  if (!payload || !Array.isArray(payload.devices)) return [];
  return payload.devices.slice(0, 64).flatMap((raw) => {
    const device = recordValue(raw);
    const byId = stringValue(device?.byId).slice(0, 320);
    const tty = stringValue(device?.tty).slice(0, 80);
    const usbPath = stringValue(device?.usbPath).slice(0, 80);
    if (
      !device
      || !byId.startsWith("/dev/serial/by-id/")
      || !/^\/dev\/tty(?:ACM|USB)[0-9]{1,4}$/.test(tty)
      || !/^[0-9]+-[0-9]+(?:\.[0-9]+)*$/.test(usbPath)
    ) return [];
    return [{
      byId,
      manufacturer: stringValue(device.manufacturer).slice(0, 256),
      product: stringValue(device.product).slice(0, 256),
      productId: stringValue(device.productId).slice(0, 16),
      serial: stringValue(device.serial).slice(0, 256),
      tty,
      usbPath,
      vendorId: stringValue(device.vendorId).slice(0, 16),
    }];
  });
}

export function buildDiagnosticBundleFindings(
  evidence: DiagnosticBundleEvidence,
  session: number,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  if (evidence.config) findings.push(...buildDiagnosticConfigFindings(evidence.config, session));
  if (evidence.hostScheduling) {
    const finding = hostSchedulingFinding(evidence.hostScheduling, session);
    if (finding) findings.push(finding);
  }
  const printerState = evidence.printer?.state || evidence.server?.klippyState || "";
  if (["disconnected", "error", "shutdown"].includes(printerState.toLowerCase())) {
    const message = evidence.printer?.message || `Moonraker captured Klipper in the ${printerState} state.`;
    const source = evidence.printer ? "snapshots/printer-info.json" : "snapshots/server-info.json";
    findings.push({
      checks: [
        "Use the log findings and native shutdown dump to identify the event that placed Klipper in this state.",
        "Confirm the snapshot capture time matches the failed print being investigated.",
        "Do not treat a later firmware restart as proof that the underlying hardware or configuration fault is resolved.",
      ],
      confidence: "observed",
      detail: `The diagnostic bundle captured Klipper in the ${printerState} state.${message ? ` ${message}` : ""}`,
      evidence: [snapshotEvidence(source, message, session)],
      family: printerState === "disconnected" ? "communication" : "software",
      id: "bundle-printer-state",
      session,
      severity: printerState === "shutdown" ? "critical" : "error",
      title: `Bundle captured Klipper ${printerState}`,
    });
  }
  if (evidence.server?.failedComponents.length) {
    const components = evidence.server.failedComponents.join(", ");
    findings.push({
      checks: [
        "Review moonraker.log for the first traceback or configuration error emitted by each failed component.",
        "Verify the component's configuration and Python dependencies before restarting Moonraker.",
        "Confirm the component loads successfully after applying a fix.",
      ],
      confidence: "observed",
      detail: `Moonraker reported components that failed to load: ${components}.`,
      evidence: [snapshotEvidence("snapshots/server-info.json", `failed_components: ${components}`, session)],
      family: "software",
      id: "bundle-moonraker-failed-components",
      session,
      severity: "error",
      title: "Moonraker components failed to load",
    });
  }
  if (evidence.server?.warnings.length) {
    const warningText = evidence.server.warnings.slice(0, 5).join(" ");
    findings.push({
      checks: [
        "Review each Moonraker warning and remove obsolete or invalid configuration.",
        "Check moonraker.log for surrounding initialization context.",
      ],
      confidence: "observed",
      detail: `Moonraker reported ${evidence.server.warnings.length} runtime or configuration warning${evidence.server.warnings.length === 1 ? "" : "s"}.`,
      evidence: [snapshotEvidence("snapshots/server-info.json", warningText, session)],
      family: "configuration",
      id: "bundle-moonraker-warnings",
      session,
      severity: "warning",
      title: "Moonraker reported configuration warnings",
    });
  }
  const failedJob = evidence.jobs.find((job) =>
    ["error", "interrupted", "klippy_disconnect", "klippy_shutdown"].includes(job.status.toLowerCase()));
  if (failedJob) {
    findings.push({
      checks: [
        "Match the job start and end timestamps with the corresponding Klipper session.",
        "Review the log incident and shutdown context for the first error before this recorded outcome.",
        "Use the cached G-code responses to identify commands or macros immediately preceding the failure.",
      ],
      confidence: "observed",
      detail: `Moonraker recorded ${failedJob.filename || "the print"} with the outcome ${failedJob.status} after ${formatSeconds(failedJob.totalDuration)}.`,
      evidence: [snapshotEvidence(
        "snapshots/job-history.json",
        `${failedJob.status}: ${failedJob.filename || "(filename unavailable)"}`,
        session,
      )],
      family: "print",
      id: "bundle-failed-job",
      session,
      severity: failedJob.status.toLowerCase() === "klippy_shutdown" ? "critical" : "error",
      title: `Moonraker recorded a ${failedJob.status.replace(/_/g, " ")} print`,
    });
  }
  evidence.thermalHistory.forEach((series) => {
    const thermal = thermalHistoryFinding(series, session);
    if (thermal) findings.push(thermal);
  });
  return findings;
}

function hostSchedulingFinding(
  scheduling: NonNullable<DiagnosticBundleEvidence["hostScheduling"]>,
  session: number,
): DiagnosticFinding | null {
  const nonPerformance = Object.entries(scheduling.governors)
    .filter(([, governor]) => governor && governor !== "performance");
  const activeSerialIrqs = scheduling.serialIrqs.filter((irq) => irq.effectiveCpuList);
  const concentratedCpu = activeSerialIrqs.length >= 2
    && activeSerialIrqs.every((irq) => irq.effectiveCpuList === activeSerialIrqs[0].effectiveCpuList)
    ? activeSerialIrqs[0].effectiveCpuList
    : "";
  if (!nonPerformance.length && !concentratedCpu && scheduling.irqbalanceState !== "active") return null;
  const risks = [
    nonPerformance.length
      ? `CPU policies using a non-performance governor: ${nonPerformance.map(([policy, governor]) => `${policy}=${governor}`).join(", ")}`
      : "",
    concentratedCpu
      ? `multiple serial IRQs were effective only on CPU list ${concentratedCpu}`
      : "",
    scheduling.irqbalanceState === "active" ? "irqbalance was active" : "",
  ].filter(Boolean);
  const serviceContext = scheduling.services
    .filter((service) => service.activeState === "active" && (service.cpuAllowedList || service.cpuAffinity))
    .map((service) => `${service.name}=${service.cpuAllowedList || service.cpuAffinity}`)
    .join(", ");
  return {
    checks: [
      "Correlate this capture-time snapshot with the failure timestamp; governors and affinities may have changed after the log event.",
      "For deadline or communication failures, check whether Klipper, Moonraker, and serial/CAN IRQs are concentrated on the same CPU.",
      "Check boot ordering and late hardware-optimization services if tuning appears correct immediately after install but changes after a reboot.",
      "Use printer-specific host guidance before changing affinity; do not copy CPU numbers from a different board.",
    ],
    confidence: "observed",
    detail: `${risks.join("; ")}.${serviceContext ? ` Active service CPU masks: ${serviceContext}.` : ""} These settings are not a fault by themselves, but they are relevant evidence for transient scheduling-latency failures.`,
    evidence: [snapshotEvidence(
      "snapshots/host-scheduling.json",
      risks.join("; "),
      session,
    )],
    family: "host",
    id: "bundle-host-scheduling-risk",
    session,
    severity: "warning",
    title: "Host scheduling snapshot contains latency risk factors",
  };
}

function parseHostScheduling(
  payload: Record<string, unknown> | null,
): DiagnosticBundleEvidence["hostScheduling"] {
  if (!payload) return null;
  const governors = stringRecord(payload.governors, 64);
  const serialIrqs = Array.isArray(payload.serialIrqs)
    ? payload.serialIrqs.slice(0, 64).flatMap((raw) => {
      const irq = recordValue(raw);
      const number = numberValue(irq?.irq);
      const device = stringValue(irq?.device).slice(0, 80);
      if (!irq || number === null || !device) return [];
      return [{
        device,
        effectiveCpuList: stringValue(irq.effectiveCpuList).slice(0, 256),
        irq: number,
        requestedCpuList: stringValue(irq.requestedCpuList).slice(0, 256),
      }];
    })
    : [];
  const services = Array.isArray(payload.services)
    ? payload.services.slice(0, 32).flatMap((raw) => {
      const service = recordValue(raw);
      const name = stringValue(service?.name).slice(0, 80);
      if (!service || !name) return [];
      return [{
        activeState: stringValue(service.activeState).slice(0, 80),
        cpuAffinity: stringValue(service.cpuAffinity).slice(0, 256),
        cpuAllowedList: stringValue(service.cpuAllowedList).slice(0, 256),
        name,
      }];
    })
    : [];
  const scheduling = {
    governors,
    irqbalanceState: stringValue(payload.irqbalanceState).slice(0, 80),
    ondemandState: stringValue(payload.ondemandState).slice(0, 80),
    onlineCpus: stringValue(payload.onlineCpus).slice(0, 256),
    serialIrqs,
    services,
  };
  return Object.keys(governors).length
    || serialIrqs.length
    || services.some((service) => service.activeState || service.cpuAffinity || service.cpuAllowedList)
    || scheduling.onlineCpus
    || scheduling.irqbalanceState
    || scheduling.ondemandState
    ? scheduling
    : null;
}

function thermalHistoryFinding(
  series: DiagnosticBundleThermalSeries,
  session: number,
): DiagnosticFinding | null {
  const count = Math.min(series.temperatures.length, series.targets.length, series.powers.length);
  if (count < 30) return null;
  const recent = Array.from({ length: Math.min(60, count) }, (_, offset) => count - Math.min(60, count) + offset)
    .flatMap((index) => {
      const temperature = series.temperatures[index];
      const target = series.targets[index];
      const power = series.powers[index];
      return temperature === null || target === null || power === null || target <= 0 || power < 0.8
        ? []
        : [{ power, target, temperature }];
    });
  if (recent.length < 30) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const targetGap = last.target - last.temperature;
  if (targetGap < 10) return null;
  const change = last.temperature - first.temperature;
  const diagnosis = change <= -3
    ? {
      detail: `${series.name} fell from ${first.temperature.toFixed(1)} °C to ${last.temperature.toFixed(1)} °C while its target remained near ${last.target.toFixed(1)} °C and heater power stayed at or above 80%.`,
      title: `${series.name} cooled while under high power`,
    }
    : Math.abs(change) < 1
    ? {
      detail: `${series.name} changed by only ${change.toFixed(1)} °C across ${recent.length} seconds while its target remained near ${last.target.toFixed(1)} °C and heater power stayed at or above 80%.`,
      title: `${series.name} did not heat under sustained power`,
    }
    : null;
  if (!diagnosis) return null;
  return {
    checks: [
      `Inspect ${series.name}'s heater, sensor attachment, wiring, connectors, and power delivery.`,
      "Compare the temperature history with fan changes, chamber heating, and other high-current loads.",
      "Verify the configured sensor type and heater limits before attempting another long heat cycle.",
    ],
    confidence: "high",
    detail: diagnosis.detail,
    evidence: [snapshotEvidence(
      "snapshots/temperature-store.json",
      `${series.name}: ${first.temperature.toFixed(1)} °C → ${last.temperature.toFixed(1)} °C; target ${last.target.toFixed(1)} °C`,
      session,
    )],
    family: "heating",
    id: `bundle-thermal-${slug(series.name)}`,
    session,
    severity: "critical",
    title: diagnosis.title,
  };
}

function parseRuntimeSensors(status: Record<string, unknown>): DiagnosticBundleSensor[] {
  return Object.entries(status).flatMap(([name, raw]): DiagnosticBundleSensor[] => {
    const sensor = recordValue(raw);
    const temperature = numberValue(sensor?.temperature);
    if (temperature === null) return [];
    return [{
      name: name.slice(0, 120),
      power: numberValue(sensor?.power),
      target: numberValue(sensor?.target),
      temperature,
    }];
  }).slice(0, 64);
}

function parseThermalHistory(payload: Record<string, unknown>): DiagnosticBundleThermalSeries[] {
  return Object.entries(payload).flatMap(([name, raw]): DiagnosticBundleThermalSeries[] => {
    const sensor = recordValue(raw);
    const temperatures = nullableNumberArray(sensor?.temperatures);
    if (!temperatures.length) return [];
    return [{
      name: name.slice(0, 120),
      powers: alignHistory(nullableNumberArray(sensor?.powers), temperatures.length),
      targets: alignHistory(nullableNumberArray(sensor?.targets), temperatures.length),
      temperatures,
    }];
  }).slice(0, 64);
}

function parseGcode(payload: Record<string, unknown> | null): DiagnosticBundleGcodeEntry[] {
  const values = Array.isArray(payload?.gcode_store) ? payload.gcode_store : [];
  return values.slice(-300).flatMap((raw): DiagnosticBundleGcodeEntry[] => {
    const entry = recordValue(raw);
    const message = stringValue(entry?.message);
    const time = numberValue(entry?.time);
    if (!message || time === null) return [];
    return [{
      message: message.slice(0, 1_200),
      time,
      type: stringValue(entry?.type).slice(0, 40),
    }];
  });
}

function parseJobs(payload: Record<string, unknown> | null): DiagnosticBundleJob[] {
  const values = Array.isArray(payload?.jobs) ? payload.jobs : [];
  return values.slice(0, 20).flatMap((raw): DiagnosticBundleJob[] => {
    const job = recordValue(raw);
    const status = stringValue(job?.status);
    if (!job || !status) return [];
    return [{
      endTime: numberValue(job.end_time),
      filename: stringValue(job.filename).slice(0, 300),
      printDuration: numberValue(job.print_duration) ?? 0,
      startTime: numberValue(job.start_time),
      status: status.slice(0, 60),
      totalDuration: numberValue(job.total_duration) ?? 0,
    }];
  });
}

function parseSnapshot(
  text: string | undefined,
  name: string,
  warnings: string[],
): unknown {
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    warnings.push(`${name} was not valid JSON and could not be analyzed.`);
    return null;
  }
}

function resultRecord(value: unknown) {
  const outer = recordValue(value);
  return recordValue(outer?.result) ?? outer;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.slice(0, 2_000) : "";
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string")
      .slice(0, maximumSnapshotStrings)
      .map((item) => item.slice(0, 1_000))
    : [];
}

function stringRecord(value: unknown, maximumEntries: number) {
  const record = recordValue(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, maximumEntries)
      .flatMap(([key, item]) => typeof item === "string"
        ? [[key.slice(0, 80), item.slice(0, 256)]]
        : []),
  );
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function nullableNumberArray(value: unknown): Array<number | null> {
  if (!Array.isArray(value)) return [];
  return value.slice(-maximumSnapshotArrayLength).map((item) => numberValue(item));
}

function alignHistory(values: Array<number | null>, length: number) {
  if (values.length >= length) return values.slice(-length);
  return [...Array<number | null>(length - values.length).fill(null), ...values];
}

function ratio(value: number | null, total: number | null) {
  return value === null || total === null || total <= 0 ? null : Math.min(1, Math.max(0, value / total));
}

function snapshotEvidence(source: string, message: string, session: number) {
  return {
    line: 1,
    message: message.slice(0, 1_200),
    session,
    source,
    time: null,
  };
}

function formatSeconds(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  return minutes ? `${minutes}m ${rounded % 60}s` : `${rounded}s`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export const diagnosticBundleFindingSeverityRank: Record<DiagnosticSeverity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};
