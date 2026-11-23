import { failureRules, matchingFailureRules, type FailureRule } from "./failureRules";
import { ShutdownDumpCollector } from "./shutdownDump";
import { buildDiagnosticSummary } from "./summary";
import type {
  DiagnosticFinding,
  DiagnosticSeverity,
  FailureFamily,
  IncidentContext,
  IncidentLine,
  KlippyEvent,
  KlippyLogAnalysis,
  KlippySession,
  KlippyStatsSample,
  LogSourceKind,
  LogSourceSummary,
  McuSummary,
  PrintOutcome,
  PrintRunSummary,
  SensorSummary,
  ShutdownDump,
  StatsFields,
} from "./types";
import { VendorProfileDetector } from "./vendorProfiles";
import { correlatePersistentUsbEvidence, parsePersistentUsbRecord, persistentUsbMessage, type PersistentUsbEvidence } from "./persistentUsbEvidence";

const statsPattern = /^Stats\s+([0-9]+(?:\.[0-9]+)?):\s*(.*)$/;
const eventTimePattern = /\beventtime=([0-9]+(?:\.[0-9]+)?)/;
const fieldPattern = /([A-Za-z_][\w.-]*)=([^\s]+)/g;
const mcuCounterKeys = new Set([
  "bytes_invalid",
  "bytes_read",
  "bytes_retransmit",
  "bytes_write",
  "ready_bytes",
  "receive_seq",
  "retransmit_seq",
  "send_seq",
  "upcoming_bytes",
]);
const hostKeys = ["buffer_time", "cputime", "gcodein", "memavail", "print_stall", "print_time", "sysload"];
const severityRank: Record<DiagnosticSeverity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
const defaultLimits: AnalyzerLimits = {
  incidentAfterLines: 12,
  incidentBeforeLines: 24,
  maxEvents: 20_000,
  maxIncidentContexts: 300,
  maxLineLength: 1_000_000,
  maxMcusPerSession: 32,
  maxSamplesPerSession: 20_000,
  maxSensorsPerSession: 64,
  maxShutdownDumps: 20,
  maxShutdownMessagesPerStream: 30,
};

export type AnalyzerLimits = {
  incidentAfterLines: number;
  incidentBeforeLines: number;
  maxEvents: number;
  maxIncidentContexts: number;
  maxLineLength: number;
  maxMcusPerSession: number;
  maxSamplesPerSession: number;
  maxSensorsPerSession: number;
  maxShutdownDumps: number;
  maxShutdownMessagesPerStream: number;
};

export type StreamingAnalyzerOptions = {
  byteSize?: number;
  fileName?: string;
  limits?: Partial<AnalyzerLimits>;
};

type MutableSession = {
  configSection: string | null;
  endLine: number;
  eventIndex: Map<string, KlippyEvent>;
  events: KlippyEvent[];
  inConfig: boolean;
  klipperVersion: string;
  mcuVersions: Record<string, string>;
  mcuNames: Set<string>;
  number: number;
  activePrint: MutablePrintRun | null;
  pendingPrintFile: { fileName: string; fileSize: number | null } | null;
  prints: MutablePrintRun[];
  reason: string;
  samples: KlippyStatsSample[];
  sampleStride: number;
  samplesSeen: number;
  sensorNames: Set<string>;
  shakeTune: KlippySession["shakeTune"];
  serialPaths: Record<string, string>;
  source: string;
  startLine: number;
  startMonotonicTime: number | null;
  startSystemTime: number | null;
  wallTime: string;
};

type MutablePrintRun = Omit<PrintRunSummary, "outcome" | "session"> & {
  lastError: { line: number; message: string; time: number | null } | null;
  lastInterruption: { line: number; message: string; time: number | null } | null;
  outcome: PrintOutcome;
};

type ClassifiedLine = {
  category: FailureFamily | "lifecycle" | "shutdown";
  diagnosticIds: string[];
  severity: DiagnosticSeverity;
};

type PendingIncident = IncidentContext & { remainingAfterLines: number };

export function analyzeKlippyLog(
  text: string,
  options: StreamingAnalyzerOptions = {},
): KlippyLogAnalysis {
  const analyzer = new StreamingKlippyLogAnalyzer(options);
  analyzer.beginSource({
    compressed: false,
    kind: inferSourceKind(options.fileName ?? "klippy.log"),
    lineCount: 0,
    name: options.fileName ?? "klippy.log",
    size: options.byteSize ?? new Blob([text]).size,
  });
  analyzer.pushChunk(text);
  analyzer.endSource();
  return analyzer.finish();
}

export class StreamingKlippyLogAnalyzer {
  private carry = "";
  private current: MutableSession | null = null;
  private currentSource: LogSourceSummary | null = null;
  private incidents: PendingIncident[] = [];
  private lastTime: number | null = null;
  private limits: AnalyzerLimits;
  private lineCount = 0;
  private pendingIncidents: PendingIncident[] = [];
  private recentCommands: string[] = [];
  private recentLines: IncidentLine[] = [];
  private sessions: MutableSession[] = [];
  private sources: LogSourceSummary[] = [];
  private usbEvents: PersistentUsbEvidence[] = [];
  private usbBootId: string | null = null;
  private sourceLine = 0;
  private shutdownCollector: ShutdownDumpCollector;
  private truncation = {
    droppedEvents: 0,
    droppedIncidentContexts: 0,
    droppedMcuNames: 0,
    droppedSamples: 0,
    droppedSensorNames: 0,
    droppedShutdownDumps: 0,
    droppedShutdownMessages: 0,
    longLines: 0,
  };
  private vendorDetector = new VendorProfileDetector();

  constructor(private options: StreamingAnalyzerOptions = {}) {
    this.limits = { ...defaultLimits, ...options.limits };
    this.shutdownCollector = new ShutdownDumpCollector({
      maxDumps: this.limits.maxShutdownDumps,
      maxMessagesPerStream: this.limits.maxShutdownMessagesPerStream,
    }, this.truncation);
  }

  beginSource(source: LogSourceSummary) {
    if (this.currentSource) this.endSource();
    if (this.current) {
      finalizeOpenPrint(this.current, "interrupted", "The log source ended before this print recorded a completion.", this.current.endLine, this.lastTime);
      this.current = null;
    }
    this.currentSource = { ...source, lineCount: 0 };
    this.sources.push(this.currentSource);
    this.sourceLine = 0;
    this.lastTime = null;
    this.carry = "";
    this.recentCommands = [];
    this.recentLines = [];
    this.usbBootId = null;
  }

  pushChunk(chunk: string) {
    if (!this.currentSource) throw new Error("beginSource must be called before pushChunk");
    const data = this.carry + chunk;
    let start = 0;
    for (let index = 0; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;
      if (code === 13 && index === data.length - 1) break;
      this.processPhysicalLine(data.slice(start, index));
      if (code === 13 && data.charCodeAt(index + 1) === 10) index += 1;
      start = index + 1;
    }
    this.carry = data.slice(start);
    if (this.carry.length > this.limits.maxLineLength) {
      this.processPhysicalLine(this.carry.slice(0, this.limits.maxLineLength));
      this.carry = "";
      this.truncation.longLines += 1;
    }
  }

  endSource() {
    if (!this.currentSource) return;
    if (this.carry.endsWith("\r")) this.carry = this.carry.slice(0, -1);
    if (this.carry) this.processPhysicalLine(this.carry);
    this.carry = "";
    this.pendingIncidents = [];
    this.currentSource = null;
  }

  finish(): KlippyLogAnalysis {
    if (this.currentSource) this.endSource();
    const retainedSessions = this.sessions.filter((session) => session.samples.length || session.events.length);
    const sessionNumbers = new Map(retainedSessions.map((session, index) => [session.number, index + 1]));
    const finalizedSessions = retainedSessions.map((session, index) => finalizeSession(session, index + 1));
    const shutdownDumps = this.shutdownCollector.finish(sessionNumbers);
    const events = finalizedSessions.flatMap((session) => session.events);
    const prints = finalizedSessions.flatMap((session) => session.prints);
    const findings = buildFindings(finalizedSessions, shutdownDumps);
    correlatePersistentUsbEvidence(this.usbEvents.map((record) => ({ ...record, session: sessionNumbers.get(record.session) ?? record.session })), finalizedSessions, shutdownDumps, findings);
    const incidents = this.incidents.map((incident) => ({
      after: incident.after,
      anchor: incident.anchor,
      before: incident.before,
      category: incident.category,
      commandContext: incident.commandContext,
      session: sessionNumbers.get(incident.session) ?? incident.session,
      severity: incident.severity,
      source: incident.source,
      time: incident.time,
    }));
    return {
      bundle: null,
      byteSize: this.options.byteSize ?? this.sources.reduce((total, source) => total + source.size, 0),
      events,
      fileName: this.options.fileName ?? (this.sources.length === 1 ? this.sources[0]?.name : `${this.sources.length} log files`),
      findings,
      incidents,
      lineCount: this.lineCount,
      prints,
      sessions: finalizedSessions,
      shutdownDumps,
      sources: this.sources,
      summary: buildDiagnosticSummary(finalizedSessions, findings),
      truncation: this.truncation,
      vendors: this.vendorDetector.finish(),
    };
  }

  private startSession(line: number, reason: string) {
    if (this.current) {
      finalizeOpenPrint(this.current, "interrupted", "Klipper restarted before the print recorded a completion, cancellation, or explicit G-code error.", line - 1, this.lastTime);
      this.current.endLine = Math.max(this.current.endLine, line - 1);
    }
    this.current = createMutableSession(
      this.sessions.length + 1,
      line,
      reason,
      this.currentSource?.name ?? "klippy.log",
    );
    this.sessions.push(this.current);
    this.lastTime = null;
    return this.current;
  }

  private processPhysicalLine(rawLine: string) {
    if (!this.currentSource) return;
    this.sourceLine += 1;
    this.lineCount += 1;
    this.currentSource.lineCount += 1;
    const logicalLines = rawLine.split("\0");
    logicalLines.forEach((logicalLine, logicalIndex) => {
      const active = this.current ?? this.startSession(this.sourceLine, logicalIndex ? "concatenated log boundary" : "start of file");
      if (logicalIndex > 0 && (active.samples.length || active.events.length)) this.startSession(this.sourceLine, "concatenated log boundary");
      this.processLine(logicalLine, this.sourceLine);
    });
  }

  private processLine(rawLine: string, lineNumber: number) {
    if (!this.current) return;
    let line = rawLine.trim();
    if (!line) {
      this.current.endLine = lineNumber;
      return;
    }
    if (line.length > this.limits.maxLineLength) {
      line = line.slice(0, this.limits.maxLineLength);
      this.truncation.longLines += 1;
    }
    if (this.currentSource?.kind === "usb") {
      const record = parsePersistentUsbRecord(line);
      if (!record) return;
      if (this.usbBootId !== null && this.usbBootId !== record.bootId) this.current = this.startSession(lineNumber, "host boot changed");
      this.usbBootId = record.bootId;
      this.current.endLine = lineNumber;
      if (this.usbEvents.length >= this.limits.maxEvents) {
        this.truncation.droppedEvents += 1;
        return;
      }
      this.usbEvents.push({ ...record, line: lineNumber, source: this.currentSource.name, session: this.current.number });
      addEvent(this.current, lineNumber, record.monotonic, record.action === "remove" ? "warning" : "info", "communication",
        persistentUsbMessage(record), [], this.limits.maxEvents, this.truncation);
      return;
    }
    this.vendorDetector.observe(line);
    this.captureAfterContext(lineNumber, line);
    this.shutdownCollector.observe({
      line: lineNumber,
      session: this.current.number,
      source: this.currentSource?.name ?? this.current.source,
      text: line,
      time: this.lastTime,
    });

    const printerStart = /^Start printer at (.+?) \(/.exec(line);
    const printerStartAnchors = /^Start printer at (.+?) \(([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\)\s*$/.exec(line);
    if (
      printerStart
      && this.current.startLine !== lineNumber
      && (this.current.samples.length > 0 || this.current.events.length > 0 || this.current.inConfig)
    ) {
      this.current = this.startSession(lineNumber, "printer start");
    }
    this.current.endLine = lineNumber;
    observeShakeTuneActivity(this.current, line, lineNumber, this.lastTime);

    const statsMatch = statsPattern.exec(line);
    if (statsMatch) {
      const time = Number(statsMatch[1]);
      if (this.lastTime !== null && time < this.lastTime - 5) this.current = this.startSession(lineNumber, "Stats time reset");
      const sample = parseStats(this.current, lineNumber, time, statsMatch[2], this.limits, this.truncation);
      detectCounterChanges(this.current, sample, this.limits.maxEvents, this.truncation);
      retainSample(this.current, sample, this.limits.maxSamplesPerSession, this.truncation);
      this.lastTime = time;
      this.rememberLine(lineNumber, line);
      return;
    }

    if (line === "===== Config file =====") {
      this.current.inConfig = true;
      this.current.configSection = null;
      this.rememberLine(lineNumber, line);
      return;
    }
    if (this.current.inConfig && line.startsWith("=======================")) {
      this.current.inConfig = false;
      this.current.configSection = null;
      this.rememberLine(lineNumber, line);
      return;
    }
    if (this.current.inConfig) {
      parseConfigLine(this.current, line);
      this.rememberLine(lineNumber, line);
      return;
    }

    if (printerStart) this.current.wallTime = printerStart[1];
    if (printerStartAnchors) {
      this.current.startSystemTime = Number(printerStartAnchors[2]);
      this.current.startMonotonicTime = Number(printerStartAnchors[3]);
    }
    if (line.startsWith("Git version:")) this.current.klipperVersion = line.slice(line.indexOf(":") + 1).trim().replace(/^'|'$/g, "");
    const loadedMcu = /^Loaded MCU '([^']+)'\s+\d+ commands \((.*)\)$/.exec(line);
    if (loadedMcu) this.current.mcuVersions[loadedMcu[1]] = loadedMcu[2];
    if (/^(?:Virtual sdcard|Upcoming \(|Dumping gcode input|gcode command)/i.test(line)) {
      this.recentCommands.push(line.slice(0, 500));
      if (this.recentCommands.length > 12) this.recentCommands.shift();
    }

    const classification = classifyLine(line);
    trackPrintState(this.current, line, lineNumber, this.lastTime, classification);
    if (classification) {
      const explicitTime = eventTimePattern.exec(line);
      const time = explicitTime ? Number(explicitTime[1]) : this.lastTime;
      addEvent(
        this.current,
        lineNumber,
        time,
        classification.severity,
        classification.category,
        line,
        classification.diagnosticIds,
        this.limits.maxEvents,
        this.truncation,
      );
      if (classification.severity === "critical" || classification.severity === "error") {
        this.startIncident(lineNumber, line, time, classification);
      }
    }
    this.rememberLine(lineNumber, line);
  }

  private rememberLine(line: number, text: string) {
    this.recentLines.push({ line, text: text.slice(0, 2_000) });
    if (this.recentLines.length > this.limits.incidentBeforeLines) this.recentLines.shift();
  }

  private startIncident(line: number, text: string, time: number | null, classification: ClassifiedLine) {
    if (!this.current || !this.currentSource) return;
    if (this.incidents.length >= this.limits.maxIncidentContexts) {
      this.truncation.droppedIncidentContexts += 1;
      return;
    }
    const incident: PendingIncident = {
      after: [],
      anchor: { line, text: text.slice(0, 2_000) },
      before: [...this.recentLines],
      category: classification.category,
      commandContext: [...this.recentCommands],
      remainingAfterLines: this.limits.incidentAfterLines,
      session: this.current.number,
      severity: classification.severity,
      source: this.currentSource.name,
      time,
    };
    this.incidents.push(incident);
    this.pendingIncidents.push(incident);
  }

  private captureAfterContext(line: number, text: string) {
    this.pendingIncidents.forEach((incident) => {
      if (incident.remainingAfterLines <= 0) return;
      incident.after.push({ line, text: text.slice(0, 2_000) });
      incident.remainingAfterLines -= 1;
    });
    this.pendingIncidents = this.pendingIncidents.filter((incident) => incident.remainingAfterLines > 0);
  }
}

function createMutableSession(number: number, line: number, reason: string, source: string): MutableSession {
  return {
    configSection: null,
    endLine: line,
    eventIndex: new Map(),
    events: [],
    inConfig: false,
    klipperVersion: "",
    mcuVersions: {},
    mcuNames: new Set(),
    number,
    activePrint: null,
    pendingPrintFile: null,
    prints: [],
    reason,
    samples: [],
    sampleStride: 1,
    samplesSeen: 0,
    sensorNames: new Set(),
    shakeTune: {
      commands: [],
      frequencySamples: 0,
      lastFrequencyHz: null,
      lastFrequencyLine: null,
      maximumFrequencyHz: null,
      version: "",
    },
    serialPaths: {},
    source,
    startLine: line,
    startMonotonicTime: null,
    startSystemTime: null,
    wallTime: "",
  };
}

function observeShakeTuneActivity(
  session: MutableSession,
  line: string,
  lineNumber: number,
  fallbackTime: number | null,
) {
  const version = /Shake&Tune version:\s*(v?[0-9][^\s]*)/i.exec(line);
  if (version) session.shakeTune.version = version[1];

  const command = /"script"\s*:\s*"(COMPARE_BELTS_RESPONSES|AXES_SHAPER_CALIBRATION|AXES_MAP_CALIBRATION|CREATE_VIBRATIONS_PROFILE)\b[^"]*"/i.exec(line)
    ?? /^(COMPARE_BELTS_RESPONSES|AXES_SHAPER_CALIBRATION|AXES_MAP_CALIBRATION|CREATE_VIBRATIONS_PROFILE)\b/i.exec(line);
  if (command && session.shakeTune.commands.length < 20) {
    const receivedTime = /^Received\s+([0-9]+(?:\.[0-9]+)?):/.exec(line);
    const entry = {
      command: command[1].toUpperCase(),
      line: lineNumber,
      time: receivedTime ? Number(receivedTime[1]) : fallbackTime,
    };
    const previous = session.shakeTune.commands[session.shakeTune.commands.length - 1];
    if (!previous || previous.command !== entry.command || previous.line !== entry.line) {
      session.shakeTune.commands.push(entry);
    }
  }

  const frequency = /^Testing frequency:\s*([0-9]+(?:\.[0-9]+)?)\s*Hz/i.exec(line);
  if (!frequency) return;
  const value = Number(frequency[1]);
  session.shakeTune.frequencySamples += 1;
  session.shakeTune.lastFrequencyHz = value;
  session.shakeTune.lastFrequencyLine = lineNumber;
  session.shakeTune.maximumFrequencyHz = Math.max(session.shakeTune.maximumFrequencyHz ?? value, value);
}

function trackPrintState(
  session: MutableSession,
  line: string,
  lineNumber: number,
  time: number | null,
  classification: ClassifiedLine | null,
) {
  const opened = /^File opened:\s*(.+?)\s+Size:(\d+)\s*$/i.exec(line);
  if (opened) {
    finalizeOpenPrint(session, "interrupted", "A different print file was selected before this print recorded a completion.", lineNumber, time);
    session.pendingPrintFile = { fileName: opened[1], fileSize: Number(opened[2]) };
    return;
  }

  const started = /^Starting SD card print \(position (\d+)\)/i.exec(line);
  if (started) {
    const position = Number(started[1]);
    if (session.activePrint && session.activePrint.outcome === "paused") {
      session.activePrint.outcome = "unknown";
      session.activePrint.reason = "";
      session.activePrint.endLine = null;
      session.activePrint.endPosition = null;
      session.activePrint.endTime = null;
      session.activePrint.lastError = null;
      return;
    }
    finalizeOpenPrint(session, "interrupted", "Another print started before this print recorded a completion.", lineNumber, time);
    const selected = session.pendingPrintFile;
    const print: MutablePrintRun = {
      endLine: null,
      endPosition: null,
      endTime: null,
      fileName: selected?.fileName ?? "Unknown file",
      fileSize: selected?.fileSize ?? null,
      lastError: null,
      lastInterruption: null,
      outcome: "unknown",
      progress: null,
      reason: "",
      source: session.source,
      startLine: lineNumber,
      startPosition: position,
      startTime: time,
    };
    session.activePrint = print;
    session.prints.push(print);
    return;
  }

  const active = session.activePrint;
  if (!active) return;

  if (/Filament Sensor .*runout event detected/i.test(line)) {
    active.lastInterruption = { line: lineNumber, message: line, time };
  } else if (/action:paused|Print already paused/i.test(line)) {
    active.lastInterruption = { line: lineNumber, message: line, time };
  } else if (/action:resumed/i.test(line)) {
    active.lastInterruption = null;
  } else if (/action:cancel(?:led)?\b|Cancelling print|Canceling print/i.test(line)) {
    closePrint(active, "cancelled", "The print was cancelled by a user, macro, or connected client.", lineNumber, time);
    session.activePrint = null;
    return;
  }

  if (
    classification
    && classification.severity !== "info"
    && classification.category !== "lifecycle"
    && !classification.diagnosticIds.includes("requested-shutdown")
    && !classification.diagnosticIds.includes("filament-runout")
  ) {
    active.lastError = { line: lineNumber, message: line, time };
  }

  if (/^(?:Finished SD card print|Done printing file)$/i.test(line)) {
    closePrint(active, "complete", "Klipper reached the end of the selected G-code file.", lineNumber, time, active.fileSize);
    session.activePrint = null;
    return;
  }

  const exited = /^Exiting SD card print \(position (\d+)\)/i.exec(line);
  if (!exited) return;
  const position = Number(exited[1]);
  if (active.outcome === "complete") {
    closePrint(active, "complete", active.reason, lineNumber, time, position);
    session.activePrint = null;
  } else if (active.lastError) {
    closePrint(active, "failed", active.lastError.message, lineNumber, time, position);
    session.activePrint = null;
  } else {
    const interruption = active.lastInterruption;
    closePrint(
      active,
      "paused",
      interruption ? `Print paused after: ${interruption.message}` : "Klipper exited the virtual SD worker without recording completion or an error.",
      lineNumber,
      time,
      position,
    );
  }
}

function closePrint(
  print: MutablePrintRun,
  outcome: PrintOutcome,
  reason: string,
  line: number,
  time: number | null,
  position: number | null = print.endPosition,
) {
  print.endLine = line;
  print.endPosition = position;
  print.endTime = time;
  print.outcome = outcome;
  print.progress = position !== null && print.fileSize ? Math.min(1, Math.max(0, position / print.fileSize)) : null;
  print.reason = reason;
}

function finalizeOpenPrint(
  session: MutableSession,
  outcome: PrintOutcome,
  reason: string,
  line?: number,
  time: number | null = null,
) {
  if (!session.activePrint) return;
  if (session.activePrint.outcome !== "complete" && session.activePrint.outcome !== "cancelled" && session.activePrint.outcome !== "failed") {
    if (session.activePrint.lastError) {
      closePrint(
        session.activePrint,
        "failed",
        session.activePrint.lastError.message,
        session.activePrint.lastError.line,
        session.activePrint.lastError.time,
      );
    } else if (line === undefined) {
      session.activePrint.outcome = outcome;
      session.activePrint.reason = reason;
    } else {
      closePrint(session.activePrint, outcome, reason, line, time);
    }
  }
  session.activePrint = null;
}

function parseConfigLine(session: MutableSession, line: string) {
  const section = /^\[([^\]]+)\]$/.exec(line);
  if (section) {
    const mcu = /^mcu(?:\s+(.+))?$/i.exec(section[1]);
    session.configSection = mcu ? mcu[1] ?? "mcu" : section[1].toLowerCase() === "beacon" ? "beacon" : null;
    return;
  }
  if (session.configSection && /^serial\s*=/i.test(line)) {
    session.serialPaths[session.configSection] = line.slice(line.indexOf("=") + 1).trim();
  }
}

function parseStats(
  session: MutableSession,
  line: number,
  time: number,
  body: string,
  limits: AnalyzerLimits,
  truncation: KlippyLogAnalysis["truncation"],
): KlippyStatsSample {
  const sample: KlippyStatsSample = { host: {}, line, mcus: {}, sensors: {}, session: session.number, source: session.source, time };
  const segmentPattern = /([A-Za-z_][\w.-]*):\s+/g;
  const segments = [...body.matchAll(segmentPattern)];
  const prefixEnd = segments[0]?.index ?? body.length;
  Object.assign(sample.host, parseFields(body.slice(0, prefixEnd), new Set(hostKeys)));

  segments.forEach((segment, index) => {
    const start = (segment.index ?? 0) + segment[0].length;
    const end = segments[index + 1]?.index ?? body.length;
    const fields = parseFields(body.slice(start, end));
    if (Object.keys(fields).some((key) => mcuCounterKeys.has(key))) {
      if (session.mcuNames.has(segment[1]) || session.mcuNames.size < limits.maxMcusPerSession) {
        session.mcuNames.add(segment[1]);
        sample.mcus[segment[1]] = fields;
      } else {
        truncation.droppedMcuNames += 1;
      }
    }
    if ("temp" in fields || "target" in fields) {
      if (session.sensorNames.has(segment[1]) || session.sensorNames.size < limits.maxSensorsPerSession) {
        session.sensorNames.add(segment[1]);
        sample.sensors[segment[1]] = fields;
      } else {
        truncation.droppedSensorNames += 1;
      }
    }
    Object.entries(fields).forEach(([name, value]) => {
      if (name !== "temp" && /_(?:temp|temperature)$/.test(name) && typeof value === "number" && Number.isFinite(value)) {
        const sensorName = `${segment[1]} ${name}`;
        if (session.sensorNames.has(sensorName) || session.sensorNames.size < limits.maxSensorsPerSession) {
          session.sensorNames.add(sensorName);
          sample.sensors[sensorName] = { temp: value };
        } else {
          truncation.droppedSensorNames += 1;
        }
      }
    });
  });

  hostKeys.forEach((key) => {
    const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(body);
    if (match) sample.host[key] = parseValue(match[1]);
  });
  return sample;
}

function parseFields(value: string, allowed?: Set<string>): StatsFields {
  const result: StatsFields = {};
  for (const match of value.matchAll(fieldPattern)) {
    if (!allowed || allowed.has(match[1])) result[match[1]] = parseValue(match[2]);
  }
  return result;
}

function parseValue(value: string): number | string {
  const normalized = value.replace(/,$/, "");
  const number = Number(normalized);
  return normalized !== "" && Number.isFinite(number) ? number : normalized;
}

function classifyLine(line: string): ClassifiedLine | null {
  const rules = matchingFailureRules(line);
  const diagnosticIds = rules.map((rule) => rule.id);
  if (/^TMC '[^']+' reports (?:GSTAT|DRV_STATUS):\s*0+\b/i.test(line)) {
    return { category: "stepper", diagnosticIds: ["tmc-status-cleared"], severity: "info" };
  }
  if (line.startsWith("Transition to shutdown state:")) return { category: "shutdown", diagnosticIds, severity: "critical" };
  if (/MCU '[^']+' shutdown:/i.test(line)) {
    return { category: rules[0]?.family ?? "firmware", diagnosticIds, severity: "critical" };
  }
  if (rules.length) {
    const mostSevere = [...rules].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])[0];
    return { category: mostSevere.family, diagnosticIds, severity: mostSevere.severity };
  }
  if (/action:(?:paused|resumed|cancel(?:led)?)\b|Print (?:already paused|is not paused, resume aborted)/i.test(line)) {
    return { category: "print", diagnosticIds, severity: "info" };
  }
  if (/^(?:SD busy|Printer not ready|SD write not supported)$/i.test(line)) {
    return { category: "print", diagnosticIds, severity: "warning" };
  }
  if (/^(?:Virtual sdcard|Upcoming \(|Dumping gcode input|gcode command)/i.test(line)) {
    return { category: "print", diagnosticIds, severity: "info" };
  }
  if (/Got error|Got EOF|Communication timeout|Timeout with MCU/i.test(line)) return { category: "communication", diagnosticIds, severity: "error" };
  if (/Traceback|CommandError:|Error:|Exception:|Unable to/i.test(line)) return { category: "software", diagnosticIds, severity: "error" };
  if (/warning|deprecated/i.test(line)) return { category: "software", diagnosticIds, severity: "warning" };
  if (/^(?:Loaded MCU|Configured MCU|Git version:|Start printer at|Starting Klippy|Restarting printer|Starting SD card print|Finished SD card print|Exiting SD card print|Done printing file|File opened:|File selected|SAVE_CONFIG to |Printer is ready|Printer is shutdown|Klipper state:)/.test(line)) {
    return { category: "lifecycle", diagnosticIds, severity: "info" };
  }
  return null;
}

function addEvent(
  session: MutableSession,
  line: number,
  time: number | null,
  severity: DiagnosticSeverity,
  category: KlippyEvent["category"],
  rawMessage: string,
  diagnosticIds: string[],
  maximumEvents: number,
  truncation: KlippyLogAnalysis["truncation"],
) {
  const message = rawMessage.replace(/\s+/g, " ").trim().slice(0, 1200);
  const key = `${severity}\0${category}\0${message}`;
  const existing = session.eventIndex.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastLine = line;
    existing.lastTime = time ?? existing.lastTime;
    existing.diagnosticIds = [...new Set([...existing.diagnosticIds, ...diagnosticIds])];
    return;
  }
  if (session.eventIndex.size >= maximumEvents) {
    truncation.droppedEvents += 1;
    return;
  }
  const event: KlippyEvent = {
    category,
    count: 1,
    diagnosticIds: [...new Set(diagnosticIds)],
    firstLine: line,
    firstTime: time,
    lastLine: line,
    lastTime: time,
    message,
    session: session.number,
    severity,
    source: session.source,
  };
  session.eventIndex.set(key, event);
  session.events.push(event);
}

function detectCounterChanges(
  session: MutableSession,
  sample: KlippyStatsSample,
  maximumEvents: number,
  truncation: KlippyLogAnalysis["truncation"],
) {
  const previous = session.samples[session.samples.length - 1];
  if (!previous) return;
  Object.entries(sample.mcus).forEach(([name, fields]) => {
    const oldFields = previous.mcus[name];
    if (!oldFields) return;
    ([
      ["bytes_retransmit", "retransmitted bytes"],
      ["bytes_invalid", "invalid bytes"],
    ] as const).forEach(([key, label]) => {
      const before = numeric(oldFields[key]);
      const after = numeric(fields[key]);
      if (before !== null && after !== null && after > before) {
        addEvent(session, sample.line, sample.time, "warning", "communication", `MCU '${name}' ${label} increased by ${Math.round(after - before)} (${Math.round(before)} to ${Math.round(after)})`, ["serial-quality"], maximumEvents, truncation);
      }
    });
  });
}

function retainSample(
  session: MutableSession,
  sample: KlippyStatsSample,
  maximumSamples: number,
  truncation: KlippyLogAnalysis["truncation"],
) {
  session.samplesSeen += 1;
  session.samples.push(sample);
  if (session.samples.length <= maximumSamples) return;
  const previousLength = session.samples.length;
  const compacted = session.samples.filter((_, index) =>
    index === 0 || index === previousLength - 1 || index % 2 === 0);
  session.samples = compacted;
  session.sampleStride *= 2;
  truncation.droppedSamples += previousLength - compacted.length;
}

function finalizeSession(session: MutableSession, number: number): KlippySession {
  finalizeOpenPrint(
    session,
    "unknown",
    "The supplied log ended while this print was still active, so its final outcome is not recorded.",
    session.endLine,
    session.samples[session.samples.length - 1]?.time ?? null,
  );
  session.number = number;
  session.events.forEach((event) => { event.session = number; });
  session.samples.forEach((sample) => { sample.session = number; });
  const firstTime = session.samples[0]?.time ?? null;
  const lastTime = session.samples[session.samples.length - 1]?.time ?? null;
  const loads = session.samples.map((sample) => numeric(sample.host.sysload)).filter(isNumber);
  const memory = session.samples.map((sample) => numeric(sample.host.memavail)).filter(isNumber);
  const shutdown = session.events.find((event) => event.category === "shutdown");
  return {
    endLine: session.endLine,
    events: session.events.sort((left, right) => left.firstLine - right.firstLine),
    firstTime,
    host: {
      maxSystemLoad: loads.length ? Math.max(...loads) : null,
      minAvailableMemoryMib: memory.length ? Math.min(...memory) / 1024 : null,
    },
    klipperVersion: session.klipperVersion,
    lastTime,
    mcus: summarizeMcus(session),
    number,
    prints: session.prints.map((print) => ({
      endLine: print.endLine,
      endPosition: print.endPosition,
      endTime: print.endTime,
      fileName: print.fileName,
      fileSize: print.fileSize,
      outcome: print.outcome,
      progress: print.progress,
      reason: print.reason,
      session: number,
      source: print.source,
      startLine: print.startLine,
      startPosition: print.startPosition,
      startTime: print.startTime,
    })),
    reason: session.reason,
    samples: session.samples,
    sensors: summarizeSensors(session.samples),
    shakeTune: session.shakeTune,
    shutdownReason: shutdown?.message.replace(/^Transition to shutdown state:\s*/, "") ?? "",
    source: session.source,
    startLine: session.startLine,
    startMonotonicTime: session.startMonotonicTime,
    startSystemTime: session.startSystemTime,
    wallTime: session.wallTime,
  };
}

function summarizeMcus(session: MutableSession): McuSummary[] {
  const names = [...new Set(session.samples.flatMap((sample) => Object.keys(sample.mcus)))].sort();
  const firstShutdownLine = session.events
    .filter((event) => event.category === "shutdown" || event.diagnosticIds.includes("mcu-scheduling"))
    .reduce((earliest, event) => Math.min(earliest, event.firstLine), Infinity);
  return names.map((name) => {
    const observations = session.samples.filter((sample) => sample.mcus[name]);
    const first = observations[0];
    const last = observations[observations.length - 1];
    const preShutdown = observations.filter((sample) => sample.line <= firstShutdownLine);
    const preShutdownLast = preShutdown[preShutdown.length - 1] ?? first;
    const preShutdownFields = preShutdownLast.mcus[name];
    let lastActivityTime = first.time;
    let previousRead = numeric(first.mcus[name].bytes_read);
    let maxSequenceLag = 0;
    let maxQueuedBytes = 0;
    observations.forEach((sample) => {
      const fields = sample.mcus[name];
      const read = numeric(fields.bytes_read);
      if (read !== null && read !== previousRead) lastActivityTime = sample.time;
      previousRead = read;
      const lag = Math.max(0, (numeric(fields.send_seq) ?? 0) - (numeric(fields.receive_seq) ?? 0));
      maxSequenceLag = Math.max(maxSequenceLag, lag);
      maxQueuedBytes = Math.max(maxQueuedBytes, numeric(fields.upcoming_bytes) ?? 0);
    });
    const firstFields = first.mcus[name];
    const lastFields = last.mcus[name];
    return {
      finalSequenceLag: Math.max(0, (numeric(lastFields.send_seq) ?? 0) - (numeric(lastFields.receive_seq) ?? 0)),
      invalidBytesDelta: difference(firstFields.bytes_invalid, lastFields.bytes_invalid),
      lastActivityTime,
      maxQueuedBytes,
      maxSequenceLag,
      name,
      postShutdownInvalidBytesDelta: difference(preShutdownFields.bytes_invalid, lastFields.bytes_invalid),
      postShutdownRetransmittedBytesDelta: difference(preShutdownFields.bytes_retransmit, lastFields.bytes_retransmit),
      preShutdownInvalidBytesDelta: difference(firstFields.bytes_invalid, preShutdownFields.bytes_invalid),
      preShutdownRetransmittedBytesDelta: difference(firstFields.bytes_retransmit, preShutdownFields.bytes_retransmit),
      retransmittedBytesDelta: difference(firstFields.bytes_retransmit, lastFields.bytes_retransmit),
      samples: observations.length,
      serialPath: session.serialPaths[name] ?? "",
      stalledForSeconds: Math.max(0, last.time - lastActivityTime),
      version: session.mcuVersions[name] ?? "",
    };
  });
}

function summarizeSensors(samples: KlippyStatsSample[]): SensorSummary[] {
  const names = [...new Set(samples.flatMap((sample) => Object.keys(sample.sensors)))].sort();
  return names.flatMap((name) => {
    const values = samples.map((sample) => numeric(sample.sensors[name]?.temp)).filter(isNumber);
    if (!values.length) return [];
    return [{ final: values[values.length - 1], maximum: Math.max(...values), minimum: Math.min(...values), name, samples: values.length }];
  });
}

function buildFindings(sessions: KlippySession[], shutdownDumps: ShutdownDump[]): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  sessions.forEach((session) => {
    const firstShutdownLine = session.events
      .filter((event) => event.category === "shutdown" || event.diagnosticIds.includes("mcu-scheduling"))
      .reduce((earliest, event) => Math.min(earliest, event.firstLine), Infinity);
    const matchedRules = new Map<string, { events: KlippyEvent[]; rule: FailureRule }>();
    session.events.forEach((event) => event.diagnosticIds.forEach((id) => {
      if (id === "python-exception" && event.diagnosticIds.includes("qidi-toolchange-adapter-mismatch")) return;
      const rule = failureRules.find((candidate) => candidate.id === id);
      if (!rule) return;
      const entry = matchedRules.get(id) ?? { events: [], rule };
      entry.events.push(event);
      matchedRules.set(id, entry);
    }));
    const clearedStartupTmcFaults = session.events.filter((event) =>
      isClearedStartupTmcFault(session, event));
    matchedRules.forEach(({ events: matchedEvents, rule }) => {
      const events = rule.id === "tmc-driver-failure" || rule.id === "power-reset"
        ? matchedEvents.filter((event) => !clearedStartupTmcFaults.includes(event))
        : matchedEvents;
      if (!events.length) return;
      const downstreamCommunication = new Set(["mcu-communication-loss", "serial-quality", "usb-device-loss"]);
      const consequenceOnly = Number.isFinite(firstShutdownLine)
        && downstreamCommunication.has(rule.id)
        && events.every((event) => event.firstLine > firstShutdownLine);
      findings.push({
        checks: rule.checks,
        confidence: consequenceOnly ? "observed" : rule.confidence,
        detail: consequenceOnly
          ? `This was logged only after Klipper had already entered shutdown, so it is likely fallout rather than the initiating fault. ${rule.detail}`
          : rule.detail,
        evidence: events.slice(0, 6).map((event) => ({ line: event.firstLine, message: event.message, session: session.number, source: event.source, time: event.firstTime })),
        family: rule.family,
        id: rule.id,
        session: session.number,
        severity: consequenceOnly ? "warning" : rule.severity,
        title: consequenceOnly ? `${rule.title} reported after shutdown` : rule.title,
      });
    });
    if (clearedStartupTmcFaults.length) {
      findings.push(tmcStartupTransientFinding(session, clearedStartupTmcFaults));
    }

    findings.push(...printOutcomeFindings(session));
    findings.push(...shakeTuneFindings(session));
    findings.push(...timerSchedulingCorrelationFindings(session));
    findings.push(...thermalTrackingFindings(session));
    findings.push(...thermalHealthFindings(session));
    findings.push(...mcuTrendFindings(session));
    findings.push(...shutdownDumpFindings(
      session,
      shutdownDumps.filter((dump) => dump.session === session.number),
    ));

    const stalled = session.mcus.filter((mcu) => mcu.stalledForSeconds >= 3 && session.shutdownReason);
    if (stalled.length) {
      findings.push({
        checks: ["Use the last advancing receive counter to distinguish the first failed MCU from devices stopped by shutdown.", "Compare whether failed endpoints share a USB hub, CAN segment, power rail, or harness."],
        confidence: "observed",
        detail: `Receive counters stopped advancing for at least three seconds on ${stalled.map((mcu) => mcu.name).join(", ")}.`,
        evidence: session.events.filter((event) => event.category === "shutdown").slice(0, 1).map((event) => ({ line: event.firstLine, message: event.message, session: session.number, source: event.source, time: event.firstTime })),
        family: "communication",
        id: "mcu-counter-stall",
        session: session.number,
        severity: "error",
        title: "MCU receive counters stopped advancing",
      });
    }

    const repeated = [...session.events].filter((event) => event.count >= 10).sort((left, right) => right.count - left.count)[0];
    if (repeated) {
      findings.push({
        checks: ["Resolve or suppress the first underlying exception before interpreting later log noise.", "Check whether the repeated operation is a status poll, macro loop, or reconnect attempt."],
        confidence: "observed",
        detail: `Repeated ${repeated.count.toLocaleString()} times: ${repeated.message}`,
        evidence: [{ line: repeated.firstLine, message: repeated.message, session: session.number, source: repeated.source, time: repeated.firstTime }],
        family: "software",
        id: `repeated-${repeated.firstLine}`,
        session: session.number,
        severity: "warning",
        title: "High-frequency recurring message",
      });
    }

    if ((session.host.maxSystemLoad ?? 0) >= 10) {
      findings.push(hostFinding(session, "host-high-load", "High host load observed", `Maximum reported system load was ${session.host.maxSystemLoad?.toFixed(2)}.`, "Check CPU saturation, I/O wait, thermal throttling, and competing services."));
    }
    if ((session.host.minAvailableMemoryMib ?? Infinity) < 64) {
      findings.push(hostFinding(session, "host-low-memory", "Low host memory observed", `Minimum available memory was ${session.host.minAvailableMemoryMib?.toFixed(1)} MiB.`, "Check memory pressure, swap activity, and services growing during the print."));
    }

    if (session.shutdownReason && !hasSpecificShutdownFinding(findings, session.number)) {
      const shutdown = session.events.find((event) => event.category === "shutdown")!;
      findings.push({
        checks: ["Use the exact shutdown reason and immediately preceding timeline events as the starting point.", "Preserve the complete log so an additional diagnostic rule can be added without guessing."],
        confidence: "observed",
        detail: session.shutdownReason,
        evidence: [{ line: shutdown.firstLine, message: shutdown.message, session: session.number, source: shutdown.source, time: shutdown.firstTime }],
        family: "software",
        id: "unclassified-shutdown",
        session: session.number,
        severity: "critical",
        title: "Klipper entered shutdown for an unclassified reason",
      });
    }
  });
  correlateMissingMcuWithKernelUsbDisconnects(sessions, shutdownDumps, findings);
  return findings.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || right.session - left.session || left.title.localeCompare(right.title));
}

function isClearedStartupTmcFault(session: KlippySession, event: KlippyEvent) {
  if (!/\b(?:uv_cp|undervoltage)\b/i.test(event.message)) return false;
  const driver = /TMC '([^']+)'/i.exec(event.message)?.[1];
  if (!driver) return false;
  const firstPrintLine = session.prints.reduce(
    (earliest, print) => Math.min(earliest, print.startLine),
    Infinity,
  );
  if (!Number.isFinite(firstPrintLine) || event.firstLine >= firstPrintLine) return false;
  return session.events.some((candidate) =>
    candidate.firstLine > event.firstLine
    && candidate.firstLine < firstPrintLine
    && candidate.diagnosticIds.includes("tmc-status-cleared")
    && new RegExp(`^TMC '${escapeRegExp(driver)}' reports`, "i").test(candidate.message));
}

function tmcStartupTransientFinding(
  session: KlippySession,
  faults: KlippyEvent[],
): DiagnosticFinding {
  const drivers = [...new Set(faults.flatMap((event) => {
    const driver = /TMC '([^']+)'/i.exec(event.message)?.[1];
    return driver ? [driver] : [];
  }))];
  const clears = session.events.filter((event) =>
    event.diagnosticIds.includes("tmc-status-cleared")
    && drivers.some((driver) => new RegExp(`^TMC '${escapeRegExp(driver)}' reports`, "i").test(event.message)));
  return {
    checks: [
      "Treat this as startup history unless the same driver flag returns during motion or heating.",
      "If it recurs, inspect the named driver supply, wiring, connector, and motor load at the recurrence time.",
      "Compare future occurrences with bed heating and other high-current loads before attributing an unrelated print failure to power.",
    ],
    confidence: "observed",
    detail: `${drivers.join(", ")} reported an undervoltage status before the print, then returned a zero status before printing began. The cleared startup flag is retained as context but is not treated as the initiating print failure.`,
    evidence: [
      ...faults.slice(0, 3).map((event) => ({
        line: event.firstLine,
        message: event.message,
        session: session.number,
        source: event.source,
        time: event.firstTime,
      })),
      ...clears.slice(0, 3).map((event) => ({
        line: event.firstLine,
        message: event.message,
        session: session.number,
        source: event.source,
        time: event.firstTime,
      })),
    ],
    family: "stepper",
    id: "tmc-startup-status-cleared",
    session: session.number,
    severity: "warning",
    title: "TMC startup fault cleared before printing",
  };
}

function timerSchedulingCorrelationFindings(session: KlippySession): DiagnosticFinding[] {
  const failure = session.events
    .filter((event) => /Timer too close/i.test(event.message))
    .sort((left, right) => left.firstLine - right.firstLine)[0];
  if (!failure) return [];

  const preFailureSamples = session.samples.filter((sample) => sample.line <= failure.firstLine);
  if (!preFailureSamples.length) return [];
  const namedMcu = /MCU '([^']+)'/i.exec(failure.message)?.[1] ?? "";
  const candidates = session.mcus
    .map((mcu) => ({
      mcu,
      observations: preFailureSamples.filter((sample) => sample.mcus[mcu.name]),
    }))
    .filter((candidate) => candidate.observations.length > 0)
    .map((candidate) => {
      const first = candidate.observations[0];
      const last = candidate.observations[candidate.observations.length - 1];
      return {
        ...candidate,
        invalidDelta: difference(
          first.mcus[candidate.mcu.name].bytes_invalid,
          last.mcus[candidate.mcu.name].bytes_invalid,
        ),
        retransmitDelta: difference(
          first.mcus[candidate.mcu.name].bytes_retransmit,
          last.mcus[candidate.mcu.name].bytes_retransmit,
        ),
        sequenceLag: Math.max(
          0,
          (numeric(last.mcus[candidate.mcu.name].send_seq) ?? 0)
            - (numeric(last.mcus[candidate.mcu.name].receive_seq) ?? 0),
        ),
      };
    });
  const selected = candidates.find((candidate) => candidate.mcu.name === namedMcu)
    ?? [...candidates].sort((left, right) =>
      right.retransmitDelta - left.retransmitDelta
      || right.sequenceLag - left.sequenceLag)[0];
  if (!selected) return [];

  const lastSampleTime = preFailureSamples[preFailureSamples.length - 1].time;
  const localWindow = preFailureSamples.filter((sample) => sample.time >= lastSampleTime - 120);
  const loads = localWindow.map((sample) => numeric(sample.host.sysload)).filter(isNumber);
  const memory = localWindow.map((sample) => numeric(sample.host.memavail)).filter(isNumber);
  const cpuSamples = localWindow.flatMap((sample) => {
    const cputime = numeric(sample.host.cputime);
    return cputime === null ? [] : [{ cputime, time: sample.time }];
  });
  const cpuRate = cpuSamples.length >= 2
    ? (cpuSamples[cpuSamples.length - 1].cputime - cpuSamples[0].cputime)
      / Math.max(1, cpuSamples[cpuSamples.length - 1].time - cpuSamples[0].time)
    : null;
  const maximumLoad = loads.length ? Math.max(...loads) : null;
  const minimumMemoryMib = memory.length ? Math.min(...memory) / 1024 : null;
  const hostTemperature = localWindow.flatMap((sample) =>
    Object.entries(sample.sensors).flatMap(([name, fields]) => {
      const temperature = numeric(fields.temp);
      return temperature !== null && /(?:^|[\s_-])(?:cb1|host|soc|cpu|raspberry|rpi)(?:$|[\s_-])/i.test(name)
        ? [{ name, temperature }]
        : [];
    })).sort((left, right) => right.temperature - left.temperature)[0];
  const normalHostTelemetry = maximumLoad !== null
    && maximumLoad < 4
    && minimumMemoryMib !== null
    && minimumMemoryMib >= 128
    && (cpuRate === null || cpuRate < 0.9)
    && (!hostTemperature || hostTemperature.temperature < 80);
  const transportChanged = selected.retransmitDelta > 0
    || selected.invalidDelta > 0
    || selected.sequenceLag >= 4;
  const endpoint = selected.mcu.serialPath
    ? `${selected.mcu.name} (${selected.mcu.serialPath})`
    : selected.mcu.name;
  const hostContext = [
    maximumLoad === null ? "" : `maximum system load ${maximumLoad.toFixed(2)}`,
    minimumMemoryMib === null ? "" : `minimum available memory ${minimumMemoryMib.toFixed(1)} MiB`,
    cpuRate === null ? "" : `Klipper CPU rate ${cpuRate.toFixed(2)} CPU-seconds/second`,
    hostTemperature ? `maximum ${hostTemperature.name} temperature ${hostTemperature.temperature.toFixed(1)} C` : "",
  ].filter(Boolean).join(", ");
  const interpretation = transportChanged && normalHostTelemetry
    ? "This combination favors a transient host, IRQ, or serial scheduling delay over sustained CPU, memory, or thermal saturation."
    : transportChanged
    ? "The pre-shutdown transport trend is relevant, but the retained telemetry cannot by itself distinguish host scheduling from physical link or MCU-side latency."
    : normalHostTelemetry
    ? "The retained telemetry does not show sustained host resource pressure; check transient scheduling and MCU workload rather than relying on session-wide averages."
    : "The retained log proves the missed deadline but does not contain enough local host telemetry to isolate host, transport, or MCU workload.";
  const firstObservation = selected.observations[0];
  const lastObservation = selected.observations[selected.observations.length - 1];

  return [{
    checks: [
      "Check CPU frequency governors, thermal throttling, I/O wait, and late-starting host optimization services around the failure.",
      "Inspect the affected serial or CAN IRQ affinity together with the Klipper and Moonraker CPU masks; avoid concentrating every latency-sensitive task and interrupt on one CPU.",
      "Compare pre-failure retransmit and invalid-byte growth with kernel serial, USB, or CAN errors before deciding whether the physical link or host scheduling is primary.",
      "If host and transport evidence remain clean, review MCU step rate, software PWM load, clock configuration, and other work scheduled near the missed deadline.",
    ],
    confidence: transportChanged && normalHostTelemetry ? "high" : "medium",
    detail: `${endpoint} reached a Timer-too-close shutdown after accumulating ${selected.retransmitDelta} retransmitted and ${selected.invalidDelta} invalid bytes before the fault, with final sequence lag ${selected.sequenceLag}.${hostContext ? ` In the final 120 seconds, host telemetry recorded ${hostContext}.` : ""} ${interpretation}`,
    evidence: [
      {
        line: firstObservation.line,
        message: `${selected.mcu.name} baseline before shutdown: retransmit=${String(firstObservation.mcus[selected.mcu.name].bytes_retransmit ?? "?")} invalid=${String(firstObservation.mcus[selected.mcu.name].bytes_invalid ?? "?")}`,
        session: session.number,
        source: session.source,
        time: firstObservation.time,
      },
      {
        line: lastObservation.line,
        message: `${selected.mcu.name} last pre-shutdown sample: retransmit=${String(lastObservation.mcus[selected.mcu.name].bytes_retransmit ?? "?")} invalid=${String(lastObservation.mcus[selected.mcu.name].bytes_invalid ?? "?")} sequence_lag=${selected.sequenceLag}`,
        session: session.number,
        source: session.source,
        time: lastObservation.time,
      },
      {
        line: failure.firstLine,
        message: failure.message,
        session: session.number,
        source: failure.source,
        time: failure.firstTime,
      },
    ],
    family: "host",
    id: "mcu-scheduling-latency-correlation",
    session: session.number,
    severity: "critical",
    title: transportChanged && normalHostTelemetry
      ? "Pre-shutdown evidence points to transient host or serial latency"
      : "Timer deadline miss correlated with pre-shutdown telemetry",
  }];
}

function shakeTuneFindings(session: KlippySession): DiagnosticFinding[] {
  const schedulingEvents = session.events
    .filter((event) => event.diagnosticIds.includes("mcu-scheduling"))
    .sort((left, right) => left.firstLine - right.firstLine);
  const failure = schedulingEvents[0];
  if (!failure) return [];

  const command = [...session.shakeTune.commands]
    .sort((left, right) => Math.abs(left.line - failure.firstLine) - Math.abs(right.line - failure.firstLine))[0];
  const frequencyNearFailure = session.shakeTune.lastFrequencyLine !== null
    && session.shakeTune.lastFrequencyLine <= failure.firstLine
    && failure.firstLine - session.shakeTune.lastFrequencyLine <= 250;
  const commandNearFailure = command && Math.abs(command.line - failure.firstLine) <= 500;
  if (!frequencyNearFailure && !commandNearFailure) return [];

  const writeBackpressure = session.events.find((event) =>
    /Resource temporarily unavailable/i.test(event.message)
    && Math.abs(event.firstLine - failure.firstLine) <= 100);
  const preFailureSamples = session.samples.filter((sample) => sample.line <= failure.firstLine);
  const mainMcuSamples = preFailureSamples.filter((sample) => sample.mcus.mcu);
  const firstMainMcu = mainMcuSamples[0]?.mcus.mcu;
  const lastMainSample = mainMcuSamples[mainMcuSamples.length - 1];
  const lastMainMcu = lastMainSample?.mcus.mcu;
  const retransmittedDelta = firstMainMcu && lastMainMcu
    ? difference(firstMainMcu.bytes_retransmit, lastMainMcu.bytes_retransmit)
    : null;
  const invalidDelta = firstMainMcu && lastMainMcu
    ? difference(firstMainMcu.bytes_invalid, lastMainMcu.bytes_invalid)
    : null;
  const sequenceLag = lastMainMcu
    ? Math.max(0, (numeric(lastMainMcu.send_seq) ?? 0) - (numeric(lastMainMcu.receive_seq) ?? 0))
    : null;
  const cleanTransport = retransmittedDelta === 0 && invalidDelta === 0 && (sequenceLag ?? Infinity) <= 2;
  const hostTemperature = session.sensors
    .filter((sensor) => /(?:^|[\s_-])(?:cb1|host|soc|cpu|raspberry|pi)(?:$|[\s_-])/i.test(sensor.name))
    .sort((left, right) => right.maximum - left.maximum)[0];
  const commandName = command?.command ?? "a Shake&Tune calibration";
  const frequencyText = frequencyNearFailure && session.shakeTune.lastFrequencyHz !== null
    ? ` at ${session.shakeTune.lastFrequencyHz.toFixed(1)} Hz`
    : "";
  const versionText = session.shakeTune.version ? ` ${session.shakeTune.version}` : "";
  const pressureText = writeBackpressure
    ? " The host also reported “Resource temporarily unavailable” immediately before shutdown, which is direct evidence of write or scheduling backpressure."
    : "";
  const transportText = cleanTransport
    ? ` The last pre-shutdown main-MCU telemetry showed no growth in retransmitted or invalid bytes and sequence lag ${sequenceLag}, so the retained evidence does not point first to CAN or serial corruption.`
    : "";
  const hostText = [
    session.host.maxSystemLoad === null ? "" : `maximum system load ${session.host.maxSystemLoad.toFixed(2)}`,
    session.host.minAvailableMemoryMib === null ? "" : `minimum available memory ${session.host.minAvailableMemoryMib.toFixed(1)} MiB`,
    hostTemperature ? `maximum ${hostTemperature.name} temperature ${hostTemperature.maximum.toFixed(1)} °C` : "",
  ].filter(Boolean).join(", ");

  const evidence: DiagnosticFinding["evidence"] = [];
  if (command) evidence.push({
    line: command.line,
    message: `${command.command} invoked${session.shakeTune.version ? ` with Shake&Tune ${session.shakeTune.version}` : ""}`,
    session: session.number,
    source: session.source,
    time: command.time,
  });
  if (frequencyNearFailure && session.shakeTune.lastFrequencyLine !== null && session.shakeTune.lastFrequencyHz !== null) {
    evidence.push({
      line: session.shakeTune.lastFrequencyLine,
      message: `Shake&Tune sweep reached ${session.shakeTune.lastFrequencyHz.toFixed(1)} Hz`,
      session: session.number,
      source: session.source,
      time: failure.firstTime,
    });
  }
  if (writeBackpressure) evidence.push({
    line: writeBackpressure.firstLine,
    message: writeBackpressure.message,
    session: session.number,
    source: writeBackpressure.source,
    time: writeBackpressure.firstTime,
  });
  if (lastMainSample && cleanTransport) evidence.push({
    line: lastMainSample.line,
    message: `Pre-shutdown mcu counters: retransmit delta=${retransmittedDelta}, invalid delta=${invalidDelta}, sequence lag=${sequenceLag}`,
    session: session.number,
    source: session.source,
    time: lastMainSample.time,
  });
  evidence.push({
    line: failure.firstLine,
    message: failure.message,
    session: session.number,
    source: failure.source,
    time: failure.firstTime,
  });

  return [{
    checks: [
      "Check host CPU use, I/O wait, memory pressure, storage latency, and thermal throttling during the calibration.",
      "Update Shake&Tune and verify its temporary/result files are written on a healthy local filesystem; stop competing webcam, display, indexing, or backup workloads for a comparison run.",
      "Compare retransmit, invalid-byte, CAN error, and sequence counters before replacing cabling or changing CAN topology.",
      "If the failure follows a repeatable sweep frequency, review step rate, microsteps, velocity, and the calibration frequency range for excessive MCU workload.",
    ],
    confidence: writeBackpressure || frequencyNearFailure ? "high" : "medium",
    detail: `A Timer-too-close scheduling shutdown occurred while ${commandName} was running under Shake&Tune${versionText}${frequencyText}.${pressureText}${transportText}${hostText ? ` Recorded host context: ${hostText}.` : ""}`,
    evidence,
    family: "host",
    id: "shaketune-scheduling-pressure",
    session: session.number,
    severity: "critical",
    title: "Shake&Tune run coincided with a scheduling deadline failure",
  }];
}

function shutdownDumpFindings(session: KlippySession, dumps: ShutdownDump[]): DiagnosticFinding[] {
  return dumps.flatMap((dump, index) => {
    const results: DiagnosticFinding[] = [];
    const lostMcu = /Lost communication with MCU '([^']+)'/i.exec(dump.reason)?.[1] ?? "";
    const respondingMcus = dump.mcus.filter((mcu) => isCommandedMcuShutdown(mcu.reason));
    const dumpedNames = new Set(dump.mcus.map((mcu) => mcu.name));
    if (lostMcu && !dumpedNames.has(lostMcu) && respondingMcus.length) {
      results.push({
        checks: [
          `Inspect ${lostMcu}'s power, data path, connector, and controller before replacing or rewiring the responding MCUs.`,
          "Compare the failed endpoint with the responding MCUs to identify shared hubs, CAN segments, power rails, or harnesses.",
          "Use the retained send/receive queues to check what activity immediately preceded communication loss.",
        ],
        confidence: "high",
        detail: `${lostMcu} stopped responding and could not provide a shutdown dump. ${respondingMcus.map((mcu) => mcu.name).join(", ")} remained reachable long enough to report host-commanded shutdown reasons after the initiating communication loss (${respondingMcus.map((mcu) => `${mcu.name} (${mcu.reason})`).join(", ")}).`,
        evidence: [
          {
            line: dump.line,
            message: dump.reason,
            session: session.number,
            source: dump.source,
            time: dump.time,
          },
          ...respondingMcus.slice(0, 4).map((mcu) => ({
            line: mcu.line,
            message: `MCU '${mcu.name}' shutdown: ${mcu.reason}`,
            session: session.number,
            source: dump.source,
            time: lastMcuActivity(mcu),
          })),
        ],
        family: "communication",
        id: `shutdown-dump-lost-mcu-${index + 1}`,
        session: session.number,
        severity: "error",
        title: `${lostMcu} was the non-responding MCU`,
      });
    }

    const selfShutdowns = dump.mcus.filter((mcu) => !isCommandedMcuShutdown(mcu.reason));
    selfShutdowns.forEach((mcu) => {
      results.push({
        checks: [
          "Treat the named MCU and its exact firmware reason as the initiating fault.",
          "Compare its final serial counters and queue activity with other controllers before changing unrelated hardware.",
          "Check the MCU firmware source for the recorded shutdown reason and the hardware condition that raises it.",
        ],
        confidence: "high",
        detail: `${mcu.name} reported its own firmware shutdown reason: ${mcu.reason}. Its dump retained ${mcu.sentMessages.length} recent sent and ${mcu.receivedMessages.length} recent received messages.`,
        evidence: [{
          line: mcu.line,
          message: `MCU '${mcu.name}' shutdown: ${mcu.reason}`,
          session: session.number,
          source: dump.source,
          time: lastMcuActivity(mcu),
        }],
        family: "firmware",
        id: `shutdown-dump-mcu-reason-${mcu.name}-${index + 1}`,
        session: session.number,
        severity: "error",
        title: `${mcu.name} reported the initiating firmware shutdown`,
      });
    });
    return results;
  });
}

function correlateMissingMcuWithKernelUsbDisconnects(
  sessions: KlippySession[],
  dumps: ShutdownDump[],
  findings: DiagnosticFinding[],
) {
  const maximumCorrelationSeconds = 15;
  const missingMcuDumps = dumps.flatMap((dump) => {
    const lostMcu = /Lost communication with MCU '([^']+)'/i.exec(dump.reason)?.[1] ?? "";
    if (!lostMcu || dump.mcus.some((mcu) => mcu.name === lostMcu)) return [];
    return [{ dump, lostMcu }];
  });
  if (missingMcuDumps.length !== 1) return;

  const [{ dump, lostMcu }] = missingMcuDumps;
  const session = sessions.find((candidate) => candidate.number === dump.session);
  if (
    dump.time === null
    || session?.startSystemTime === null
    || session?.startMonotonicTime === null
    || session?.startSystemTime === undefined
    || session?.startMonotonicTime === undefined
  ) return;
  const shutdownEpoch = session.startSystemTime + (dump.time - session.startMonotonicTime);
  if (!Number.isFinite(shutdownEpoch)) return;

  const kernelDisconnects = sessions.flatMap((session) => session.events.flatMap((event) => {
    if (inferSourceKind(event.source) !== "kernel" || !event.diagnosticIds.includes("usb-device-loss")) return [];
    const path = /\busb\s+([0-9]+-[0-9.]+):\s+USB disconnect\b/i.exec(event.message)?.[1] ?? "";
    const epoch = parseKernelJournalEpoch(event.message);
    return path && epoch !== null && Math.abs(epoch - shutdownEpoch) <= maximumCorrelationSeconds
      ? [{ event, path }]
      : [];
  }));
  if (!kernelDisconnects.length || new Set(kernelDisconnects.map((item) => item.path)).size !== 1) return;

  const finding = findings.find((item) =>
    item.session === dump.session
    && item.id.startsWith("shutdown-dump-lost-mcu-")
    && item.evidence.some((evidence) => evidence.source === dump.source && evidence.line === dump.line));
  if (!finding) return;

  const path = kernelDisconnects[0].path;
  const count = kernelDisconnects.reduce((total, item) => total + item.event.count, 0);
  finding.detail += ` The same diagnostic capture contains ${count} kernel USB-disconnect record${count === 1 ? "" : "s"} for usb ${path} within ${maximumCorrelationSeconds} seconds of this shutdown. The kernel lines alone do not preserve the udev-to-topology mapping needed to prove this port is ${lostMcu}, but their timing independently supports a physical USB disappearance or controller reset.`;
  finding.checks = [
    `Confirm that kernel USB path ${path} maps to ${lostMcu}'s configured serial endpoint before replacing hardware.`,
    ...finding.checks,
  ];
  finding.evidence.push(...kernelDisconnects.slice(0, 4).map(({ event }) => ({
    line: event.firstLine,
    message: event.message,
    session: event.session,
    source: event.source,
    time: event.firstTime,
  })));
}

function parseKernelJournalEpoch(message: string) {
  const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(message)?.[1];
  if (!timestamp) return null;
  const normalized = timestamp
    .replace(",", ".")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? milliseconds / 1_000 : null;
}

function isCommandedMcuShutdown(reason: string) {
  return /^(?:shutdown due to )?(?:command|host) request$/i.test(reason.trim())
    || /^emergency stop$/i.test(reason.trim())
    || /^(?:emergency stop|shutdown) requested by host$/i.test(reason.trim());
}

function lastMcuActivity(mcu: ShutdownDump["mcus"][number]) {
  const times = [...mcu.sentMessages, ...mcu.receivedMessages]
    .map((message) => message.time)
    .filter(isNumber);
  return times.length ? Math.max(...times) : null;
}

function printOutcomeFindings(session: KlippySession): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  session.prints.forEach((print, index) => {
    const progress = print.progress === null ? "" : ` at ${(print.progress * 100).toFixed(1)}%`;
    if (print.outcome === "failed") {
      findings.push({
        checks: ["Start with the recorded G-code or shutdown error rather than treating the virtual SD exit as the root cause.", "Inspect the timeline immediately before the exit for a macro, runout, thermal, motion, or communication event.", "Correct the underlying error before retrying the same file."],
        confidence: "high",
        detail: `${print.fileName} stopped${progress}. ${print.reason}`,
        evidence: [{
          line: print.endLine ?? print.startLine,
          message: print.reason,
          session: session.number,
          source: print.source,
          time: print.endTime,
        }],
        family: "print",
        id: `print-failed-${index + 1}`,
        session: session.number,
        severity: "error",
        title: "Virtual SD print failed before completion",
      });
      return;
    }
    if (print.outcome === "interrupted") {
      findings.push({
        checks: ["Review the events immediately before the restart to determine whether it was requested or unexpected.", "Check whether a client, macro, service restart, host reboot, or Klipper shutdown interrupted the print.", "Use file position and size to identify how far the print progressed."],
        confidence: "observed",
        detail: `${print.fileName} was interrupted${progress}. ${print.reason}`,
        evidence: [{
          line: print.endLine ?? print.startLine,
          message: print.reason,
          session: session.number,
          source: print.source,
          time: print.endTime,
        }],
        family: "print",
        id: `print-interrupted-${index + 1}`,
        session: session.number,
        severity: "warning",
        title: "Print ended at a Klipper restart",
      });
    }
  });
  return findings;
}

function thermalTrackingFindings(session: KlippySession): DiagnosticFinding[] {
  const names = [...new Set(session.samples.flatMap((sample) => Object.keys(sample.sensors)))];
  return names.flatMap((name) => {
    const powered = session.samples.flatMap((sample, sampleIndex) => {
      const fields = sample.sensors[name];
      const target = numeric(fields?.target);
      const temp = numeric(fields?.temp);
      const pwm = numeric(fields?.pwm);
      return target !== null && target >= 5 && temp !== null && pwm !== null && pwm >= 0.95
        ? [{ line: sample.line, printTime: numeric(sample.host.print_time), pwm, sampleIndex, target, temp, time: sample.time }]
        : [];
    });
    if (powered.length < 2) return [];

    const groups = powered.reduce<typeof powered[]>((result, point) => {
      const group = result[result.length - 1];
      const previous = group?.[group.length - 1];
      if (!previous || point.sampleIndex !== previous.sampleIndex + 1 || Math.abs(point.target - previous.target) > 1) result.push([point]);
      else group.push(point);
      return result;
    }, []);
    const failingGroup = groups
      .filter((group) => {
        const first = group[0];
        const last = group[group.length - 1];
        return last.time - first.time >= 15
          && last.target - last.temp >= 5
          && last.temp - first.temp <= -0.5;
      })
      .sort((left, right) => (right[right.length - 1].time - right[0].time) - (left[left.length - 1].time - left[0].time))[0];
    if (!failingGroup) return [];

    const first = failingGroup[0];
    const last = failingGroup[failingGroup.length - 1];
    const duration = last.time - first.time;
    const target = last.target.toFixed(1);
    const start = first.temp.toFixed(1);
    const end = last.temp.toFixed(1);
    const printClockStalled = first.printTime !== null
      && last.printTime !== null
      && Math.abs(last.printTime - first.printTime) < 0.1;
    const printContext = printClockStalled
      ? " The print clock was not advancing during this trace, so the print was likely waiting for this heater to reach its setpoint when Klipper was restarted."
      : "";
    return [{
      checks: [
        `Inspect ${name} heater wiring, terminals, crimps, fuse, output connector, and heater resistance before retrying.`,
        "Measure the heater supply voltage both idle and at full output; check for a weak power supply, voltage drop, or failed output channel.",
        "Confirm the requested setpoint is achievable for this machine and environment, but do not weaken Klipper heater safety checks to mask the fault.",
      ],
      confidence: "high",
      detail: `${name} was commanded to ${target} °C at full heater power, but its measured temperature fell from ${start} °C to ${end} °C over ${duration.toFixed(0)} seconds.${printContext}`,
      evidence: [
        { line: first.line, message: `${name}: target=${target} temp=${start} pwm=${first.pwm.toFixed(3)}`, session: session.number, source: session.source, time: first.time },
        { line: last.line, message: `${name}: target=${target} temp=${end} pwm=${last.pwm.toFixed(3)}`, session: session.number, source: session.source, time: last.time },
      ],
      family: "heating",
      id: `heater-target-not-tracking-${name}`,
      session: session.number,
      severity: "error",
      title: `${name} could not hold its requested temperature`,
    }];
  });
}

function hostFinding(session: KlippySession, id: string, title: string, detail: string, check: string): DiagnosticFinding {
  return { checks: [check], confidence: "observed", detail, evidence: [], family: "host", id, session: session.number, severity: "warning", title };
}

function hasSpecificShutdownFinding(findings: DiagnosticFinding[], session: number) {
  return findings.some((finding) =>
    finding.session === session
    && finding.id !== "mcu-communication-loss"
    && finding.id !== "python-exception"
    && (finding.severity === "critical" || finding.id === "requested-shutdown"));
}

function numeric(value: number | string | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function difference(first: number | string | undefined, last: number | string | undefined) {
  return Math.round((numeric(last) ?? 0) - (numeric(first) ?? 0));
}

function isNumber(value: number | null): value is number {
  return value !== null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function thermalHealthFindings(session: KlippySession): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const names = [...new Set(session.samples.flatMap((sample) => Object.keys(sample.sensors)))];
  names.forEach((name) => {
    const observations = session.samples.flatMap((sample) => {
      const fields = sample.sensors[name];
      const temp = numeric(fields?.temp);
      return temp === null ? [] : [{
        line: sample.line,
        pwm: numeric(fields?.pwm),
        target: numeric(fields?.target),
        temp,
        time: sample.time,
      }];
    });
    for (let index = 1; index < observations.length; index += 1) {
      const previous = observations[index - 1];
      const current = observations[index];
      const elapsed = current.time - previous.time;
      if (previous.temp <= 1 || current.temp <= 1) continue;
      if (elapsed <= 0 || elapsed > 5 || Math.abs(current.temp - previous.temp) < 25) continue;
      findings.push({
        checks: ["Inspect the sensor wiring and connector for an intermittent open or short.", "Confirm sensor_type and pull-up configuration.", "Compare the jump with toolhead or bed movement that may be flexing the cable."],
        confidence: "high",
        detail: `${name} changed ${Math.abs(current.temp - previous.temp).toFixed(1)} °C in ${elapsed.toFixed(1)} seconds, which is not physically plausible for normal printer heating.`,
        evidence: [
          { line: previous.line, message: `${name}: ${previous.temp.toFixed(1)} °C`, session: session.number, source: session.source, time: previous.time },
          { line: current.line, message: `${name}: ${current.temp.toFixed(1)} °C`, session: session.number, source: session.source, time: current.time },
        ],
        family: "heating",
        id: `thermal-jump-${name}`,
        session: session.number,
        severity: "critical",
        title: `${name} reported an implausible temperature jump`,
      });
      break;
    }

    const powered = observations.filter((item) =>
      item.target !== null && item.target - item.temp >= 8 && item.pwm !== null && item.pwm >= 0.9);
    if (powered.length >= 2) {
      const first = powered[0];
      const last = powered[powered.length - 1];
      const duration = last.time - first.time;
      const values = powered.map((item) => item.temp);
      const rise = last.temp - first.temp;
      if (duration >= 30 && Math.max(...values) - Math.min(...values) <= 0.2) {
        findings.push({
          checks: ["Check for a disconnected heater or sensor value that is stuck in firmware.", "Measure heater voltage and resistance while the output is commanded on.", "Inspect the sensor connector and confirm its reading changes with controlled warming."],
          confidence: "high",
          detail: `${name} remained within ${(Math.max(...values) - Math.min(...values)).toFixed(1)} °C for ${duration.toFixed(0)} seconds while at least 90% heater power was requested.`,
          evidence: [
            { line: first.line, message: `${name}: target=${first.target} temp=${first.temp} pwm=${first.pwm}`, session: session.number, source: session.source, time: first.time },
            { line: last.line, message: `${name}: target=${last.target} temp=${last.temp} pwm=${last.pwm}`, session: session.number, source: session.source, time: last.time },
          ],
          family: "heating",
          id: `thermal-flatline-${name}`,
          session: session.number,
          severity: "error",
          title: `${name} did not respond to heater power`,
        });
      } else if (duration >= 60 && rise >= -0.5 && rise < 2) {
        findings.push({
          checks: ["Check heater resistance, supply voltage under load, output terminals, and connector heating.", "Confirm the configured heater can reach the requested target in the current ambient conditions.", "Inspect unexpected cooling from fans or an open chamber."],
          confidence: "medium",
          detail: `${name} rose only ${rise.toFixed(1)} °C over ${duration.toFixed(0)} seconds while driven at at least 90% power and still well below target.`,
          evidence: [
            { line: first.line, message: `${name}: target=${first.target} temp=${first.temp} pwm=${first.pwm}`, session: session.number, source: session.source, time: first.time },
            { line: last.line, message: `${name}: target=${last.target} temp=${last.temp} pwm=${last.pwm}`, session: session.number, source: session.source, time: last.time },
          ],
          family: "heating",
          id: `thermal-slow-rise-${name}`,
          session: session.number,
          severity: "warning",
          title: `${name} heated unusually slowly`,
        });
      }
    }

    const overshoot = observations.find((item) => item.target !== null && item.target >= 5 && item.temp - item.target >= 10);
    if (overshoot) {
      findings.push({
        checks: ["Confirm the sensor is firmly mounted and reading the controlled heater.", "Review PID tuning and heater power limits.", "Check for a stuck output only after verifying the reported temperature is real."],
        confidence: "observed",
        detail: `${name} exceeded its ${overshoot.target?.toFixed(1)} °C target by ${(overshoot.temp - (overshoot.target ?? overshoot.temp)).toFixed(1)} °C.`,
        evidence: [{ line: overshoot.line, message: `${name}: target=${overshoot.target} temp=${overshoot.temp}`, session: session.number, source: session.source, time: overshoot.time }],
        family: "heating",
        id: `thermal-overshoot-${name}`,
        session: session.number,
        severity: "warning",
        title: `${name} significantly overshot its target`,
      });
    }
  });
  return findings;
}

function mcuTrendFindings(session: KlippySession): DiagnosticFinding[] {
  return session.mcus.flatMap((mcu) => {
    const firstShutdownLine = session.events
      .filter((event) => event.category === "shutdown" || event.diagnosticIds.includes("mcu-scheduling"))
      .reduce((earliest, event) => Math.min(earliest, event.firstLine), Infinity);
    const observations = session.samples.filter((sample) =>
      sample.line <= firstShutdownLine && sample.mcus[mcu.name]);
    if (!observations.length) return [];
    const firstFields = observations[0].mcus[mcu.name];
    const lastFields = observations[observations.length - 1].mcus[mcu.name];
    const retransmittedBytesDelta = difference(firstFields.bytes_retransmit, lastFields.bytes_retransmit);
    const invalidBytesDelta = difference(firstFields.bytes_invalid, lastFields.bytes_invalid);
    const maxSequenceLag = observations.reduce((maximum, sample) => Math.max(
      maximum,
      Math.max(0, (numeric(sample.mcus[mcu.name].send_seq) ?? 0) - (numeric(sample.mcus[mcu.name].receive_seq) ?? 0)),
    ), 0);
    const maxQueuedBytes = observations.reduce((maximum, sample) =>
      Math.max(maximum, numeric(sample.mcus[mcu.name].upcoming_bytes) ?? 0), 0);
    if (retransmittedBytesDelta <= 0 && invalidBytesDelta <= 0 && maxSequenceLag < 4 && maxQueuedBytes < 2048) return [];
    const last = observations[observations.length - 1];
    return [{
      checks: ["Inspect the named MCU first rather than every controller stopped by the resulting shutdown.", "Compare cabling, power, hubs, CAN topology, and controller temperature.", "Use the incident timeline to see whether degradation began when a heater, fan, or motor load changed."],
      confidence: "observed",
      detail: `${mcu.name} accumulated ${retransmittedBytesDelta} retransmitted bytes and ${invalidBytesDelta} invalid bytes before shutdown, with maximum sequence lag ${maxSequenceLag} and ${maxQueuedBytes} queued bytes.`,
      evidence: last ? [{
        line: last.line,
        message: `MCU ${mcu.name}: pre-shutdown max_lag=${maxSequenceLag} retransmit_delta=${retransmittedBytesDelta} invalid_delta=${invalidBytesDelta}`,
        session: session.number,
        source: session.source,
        time: last.time,
      }] : [],
      family: "communication",
      id: `mcu-degradation-${mcu.name}`,
      session: session.number,
      severity: maxSequenceLag >= 8 || maxQueuedBytes >= 8192 ? "error" : "warning",
      title: `${mcu.name} communication degraded during the session`,
    } satisfies DiagnosticFinding];
  });
}

export function inferSourceKind(fileName: string): LogSourceKind {
  const normalized = fileName.toLowerCase();
  if (/(?:^|\/)(?:usb-events(?:\.previous)?\.log|events\.jsonl(?:\.1)?)$/.test(normalized)) return "usb";
  if (normalized.includes("klippy")) return "klippy";
  if (normalized.includes("moonraker")) return "moonraker";
  if (/(?:dmesg|kern|journal|syslog)/.test(normalized)) return "kernel";
  return "unknown";
}
