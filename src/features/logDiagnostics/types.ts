export type DiagnosticSeverity = "critical" | "error" | "warning" | "info";
export type DiagnosticConfidence = "high" | "medium" | "low" | "observed";

export type FailureFamily =
  | "communication"
  | "configuration"
  | "firmware"
  | "heating"
  | "host"
  | "motion"
  | "power"
  | "print"
  | "probe"
  | "sensor"
  | "software"
  | "storage"
  | "stepper";

export type DiagnosticEvidence = {
  line: number;
  message: string;
  session: number;
  source: string;
  time: number | null;
};

export type DiagnosticFinding = {
  checks: string[];
  confidence: DiagnosticConfidence;
  detail: string;
  evidence: DiagnosticEvidence[];
  family: FailureFamily;
  id: string;
  session: number;
  severity: DiagnosticSeverity;
  title: string;
};

export type DiagnosticSummary = {
  detail: string;
  findingId: string | null;
  session: number | null;
  title: string;
  tone: "failure" | "clue" | "clear";
};

export type KlippyEvent = {
  category: FailureFamily | "lifecycle" | "shutdown";
  count: number;
  diagnosticIds: string[];
  firstLine: number;
  firstTime: number | null;
  lastLine: number;
  lastTime: number | null;
  message: string;
  session: number;
  severity: DiagnosticSeverity;
  source: string;
};

export type StatsFields = Record<string, number | string>;

export type KlippyStatsSample = {
  host: StatsFields;
  line: number;
  mcus: Record<string, StatsFields>;
  sensors: Record<string, StatsFields>;
  session: number;
  source: string;
  time: number;
};

export type McuSummary = {
  finalSequenceLag: number;
  invalidBytesDelta: number;
  lastActivityTime: number;
  maxQueuedBytes: number;
  maxSequenceLag: number;
  name: string;
  postShutdownInvalidBytesDelta: number;
  postShutdownRetransmittedBytesDelta: number;
  preShutdownInvalidBytesDelta: number;
  preShutdownRetransmittedBytesDelta: number;
  retransmittedBytesDelta: number;
  samples: number;
  serialPath: string;
  stalledForSeconds: number;
  version: string;
};

export type SensorSummary = {
  final: number;
  maximum: number;
  minimum: number;
  name: string;
  samples: number;
};

export type PrintOutcome = "cancelled" | "complete" | "failed" | "interrupted" | "paused" | "unknown";

export type PrintRunSummary = {
  endLine: number | null;
  endPosition: number | null;
  endTime: number | null;
  fileName: string;
  fileSize: number | null;
  outcome: PrintOutcome;
  progress: number | null;
  reason: string;
  session: number;
  source: string;
  startLine: number;
  startPosition: number;
  startTime: number | null;
};

export type LogSourceKind = "kernel" | "klippy" | "moonraker" | "unknown";

export type LogSourceSummary = {
  compressed: boolean;
  kind: LogSourceKind;
  lineCount: number;
  name: string;
  size: number;
};

export type DiagnosticBundleArtifact = {
  archiveName: string;
  kind: string;
  originalSizeBytes: number;
  storedSizeBytes: number;
  truncated: boolean;
};

export type DiagnosticBundleGcodeEntry = {
  message: string;
  time: number;
  type: string;
};

export type DiagnosticBundleJob = {
  endTime: number | null;
  filename: string;
  printDuration: number;
  startTime: number | null;
  status: string;
  totalDuration: number;
};

export type DiagnosticBundleSensor = {
  name: string;
  power: number | null;
  target: number | null;
  temperature: number;
};

export type DiagnosticBundleThermalSeries = {
  name: string;
  powers: Array<number | null>;
  targets: Array<number | null>;
  temperatures: Array<number | null>;
};

export type DiagnosticConfigSection = {
  kind: "heater" | "mcu" | "motion" | "probe" | "sensor" | "system" | "verification";
  name: string;
  options: Record<string, string>;
};

export type DiagnosticConfigEvidence = {
  pendingSave: boolean;
  pendingSaveItems: string[];
  retainedSectionCount: number;
  sectionCount: number;
  sections: DiagnosticConfigSection[];
  warnings: Array<{
    message: string;
    type: string;
  }>;
};

export type DiagnosticBundleEvidence = {
  config: DiagnosticConfigEvidence | null;
  gcode: DiagnosticBundleGcodeEntry[];
  hostScheduling: {
    governors: Record<string, string>;
    irqbalanceState: string;
    ondemandState: string;
    onlineCpus: string;
    serialIrqs: Array<{
      device: string;
      effectiveCpuList: string;
      irq: number;
      requestedCpuList: string;
    }>;
    services: Array<{
      activeState: string;
      cpuAllowedList: string;
      cpuAffinity: string;
      name: string;
    }>;
  } | null;
  jobs: DiagnosticBundleJob[];
  objectCount: number;
  parseWarnings: string[];
  print: {
    filename: string;
    message: string;
    printDuration: number;
    progress: number | null;
    state: string;
    totalDuration: number;
  } | null;
  printer: {
    message: string;
    softwareVersion: string;
    state: string;
  } | null;
  sensors: DiagnosticBundleSensor[];
  server: {
    failedComponents: string[];
    klippyConnected: boolean | null;
    klippyState: string;
    moonrakerVersion: string;
    warnings: string[];
  } | null;
  thermalHistory: DiagnosticBundleThermalSeries[];
  usbSerialDevices: Array<{
    byId: string;
    manufacturer: string;
    product: string;
    productId: string;
    serial: string;
    tty: string;
    usbPath: string;
    vendorId: string;
  }>;
};

export type DiagnosticBundleSummary = {
  artifacts: DiagnosticBundleArtifact[];
  clientVersion: string;
  collectionWarnings: string[];
  evidence: DiagnosticBundleEvidence | null;
  generatedAt: string;
  schemaVersion: number;
};

export type IncidentLine = {
  line: number;
  text: string;
};

export type IncidentContext = {
  after: IncidentLine[];
  anchor: IncidentLine;
  before: IncidentLine[];
  category: KlippyEvent["category"];
  commandContext: string[];
  session: number;
  severity: DiagnosticSeverity;
  source: string;
  time: number | null;
};

export type ShutdownQueueMessage = {
  line: number;
  sequence: string;
  text: string;
  time: number | null;
};

export type ShutdownMcuDump = {
  clockFrequency: number | null;
  line: number;
  name: string;
  reason: string;
  receiveQueueCount: number;
  receivedMessages: ShutdownQueueMessage[];
  sendQueueCount: number;
  sentMessages: ShutdownQueueMessage[];
  serialStats: StatsFields;
};

export type ShutdownMotionQueue = {
  count: number;
  kind: "stepper" | "trapq";
  line: number;
  mcu: string;
  name: string;
  samples: ShutdownQueueMessage[];
};

export type ShutdownDump = {
  apiRequests: ShutdownQueueMessage[];
  endLine: number;
  gcodeCommands: ShutdownQueueMessage[];
  line: number;
  mcus: ShutdownMcuDump[];
  motionQueues: ShutdownMotionQueue[];
  reason: string;
  session: number;
  source: string;
  time: number | null;
};

export type VendorProfile = {
  evidence: string[];
  id: string;
  name: string;
};

export type AnalysisTruncation = {
  droppedEvents: number;
  droppedIncidentContexts: number;
  droppedMcuNames: number;
  droppedSamples: number;
  droppedSensorNames: number;
  droppedShutdownDumps: number;
  droppedShutdownMessages: number;
  longLines: number;
};

export type KlippySession = {
  endLine: number;
  events: KlippyEvent[];
  firstTime: number | null;
  host: {
    maxSystemLoad: number | null;
    minAvailableMemoryMib: number | null;
  };
  klipperVersion: string;
  lastTime: number | null;
  mcus: McuSummary[];
  number: number;
  prints: PrintRunSummary[];
  reason: string;
  samples: KlippyStatsSample[];
  sensors: SensorSummary[];
  shakeTune: {
    commands: Array<{
      command: string;
      line: number;
      time: number | null;
    }>;
    frequencySamples: number;
    lastFrequencyHz: number | null;
    lastFrequencyLine: number | null;
    maximumFrequencyHz: number | null;
    version: string;
  };
  shutdownReason: string;
  source: string;
  startLine: number;
  startMonotonicTime: number | null;
  startSystemTime: number | null;
  wallTime: string;
};

export type KlippyLogAnalysis = {
  bundle: DiagnosticBundleSummary | null;
  byteSize: number;
  events: KlippyEvent[];
  fileName: string;
  findings: DiagnosticFinding[];
  incidents: IncidentContext[];
  lineCount: number;
  prints: PrintRunSummary[];
  sessions: KlippySession[];
  shutdownDumps: ShutdownDump[];
  sources: LogSourceSummary[];
  summary: DiagnosticSummary;
  truncation: AnalysisTruncation;
  vendors: VendorProfile[];
};
