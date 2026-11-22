import type {
  AnalysisTruncation,
  ShutdownDump,
  ShutdownMcuDump,
  ShutdownMotionQueue,
  ShutdownQueueMessage,
  StatsFields,
} from "./types";

type ShutdownDumpLimits = {
  maxDumps: number;
  maxMessagesPerStream: number;
};

type ObserveLine = {
  line: number;
  session: number;
  source: string;
  text: string;
  time: number | null;
};

type MutableMcuDump = ShutdownMcuDump;
type MutableMotionQueue = ShutdownMotionQueue;
type ActiveSection =
  | { kind: "api" }
  | { kind: "gcode" }
  | { kind: "mcu-receive"; mcu: MutableMcuDump }
  | { kind: "mcu-send"; mcu: MutableMcuDump }
  | { kind: "motion"; queue: MutableMotionQueue }
  | null;

const statsTime = /^Stats\s+([0-9]+(?:\.[0-9]+)?):/;
const transition = /^Transition to shutdown state:\s*(.*)$/;
const mcuShutdown = /^MCU '([^']+)' (?:is )?shutdown:\s*(.*)$/;
const serialStats = /^Dumping serial stats:\s*(.*)$/;
const clockSync = /^clocksync state:\s+mcu_freq=([0-9]+)/;
const sendQueue = /^Dumping send queue ([0-9]+) messages$/;
const receiveQueue = /^Dumping receive queue ([0-9]+) messages$/;
const sentMessage = /^Sent\s+[0-9]+\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s+[0-9]+:\s+seq:\s+([0-9a-f]+),?\s*(.*)$/i;
const receivedMessage = /^Receive:\s+[0-9]+\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s+[0-9]+:\s+seq:\s+([0-9a-f]+),?\s*(.*)$/i;
const gcodeDump = /^Dumping gcode input ([0-9]+) blocks$/;
const gcodeRead = /^Read\s+([0-9]+(?:\.[0-9]+)?):\s*(.*)$/;
const apiDump = /^Dumping ([0-9]+) requests for client /;
const apiRequest = /^Received\s+([0-9]+(?:\.[0-9]+)?):\s*(.*)$/;
const stepperDump = /^Dumping stepper '([^']*)' \(([^)]+)\) ([0-9]+) queue_step:$/;
const trapqDump = /^Dumping trapq '([^']*)' ([0-9]+) moves:$/;
const stepperMessage = /^queue_step\s+[0-9]+:\s+t=([0-9]+)/;
const trapqMessage = /^move\s+[0-9]+:\s+pt=([0-9]+(?:\.[0-9]+)?)/;
const boundary = /^(?:Git version:|Start printer at|===== Config file =====)/;

export class ShutdownDumpCollector {
  private active: ShutdownDump | null = null;
  private activeMcu: MutableMcuDump | null = null;
  private activeSection: ActiveSection = null;
  private dumps: ShutdownDump[] = [];
  private firstPostDumpStats: number | null = null;
  private skippedDump: { session: number; source: string } | null = null;

  constructor(
    private limits: ShutdownDumpLimits,
    private truncation: AnalysisTruncation,
  ) {}

  observe(input: ObserveLine) {
    if (this.active && (input.session !== this.active.session || input.source !== this.active.source)) {
      this.finishActive();
    }
    if (
      this.skippedDump
      && (input.session !== this.skippedDump.session || input.source !== this.skippedDump.source)
    ) {
      this.skippedDump = null;
    }
    if (this.skippedDump) return;
    const transitionMatch = transition.exec(input.text);
    const mcuMatch = mcuShutdown.exec(input.text);
    const startsDump = transitionMatch || mcuMatch || /^Dumping /.test(input.text);
    if (!this.active && startsDump) {
      this.start(input, transitionMatch?.[1] ?? mcuMatch?.[2] ?? "Klipper diagnostic dump");
    }
    if (!this.active) return;
    this.active.endLine = input.line;

    if (boundary.test(input.text) && input.line > this.active.line) {
      this.finishActive();
      return;
    }
    const statsMatch = statsTime.exec(input.text);
    if (statsMatch) {
      const time = Number(statsMatch[1]);
      if (this.firstPostDumpStats === null) this.firstPostDumpStats = time;
      else if (time > this.firstPostDumpStats + 5) {
        this.finishActive();
        return;
      }
    }
    if (input.line - this.active.line > 5_000) {
      this.finishActive();
      return;
    }
    if (transitionMatch) {
      this.active.reason = transitionMatch[1];
      this.active.time = input.time;
      this.activeSection = null;
      return;
    }
    if (mcuMatch) {
      this.activeMcu = {
        clockFrequency: null,
        line: input.line,
        name: mcuMatch[1],
        reason: mcuMatch[2],
        receiveQueueCount: 0,
        receivedMessages: [],
        sendQueueCount: 0,
        sentMessages: [],
        serialStats: {},
      };
      this.active.mcus.push(this.activeMcu);
      this.activeSection = null;
      return;
    }
    const clockMatch = clockSync.exec(input.text);
    if (clockMatch && this.activeMcu) {
      this.activeMcu.clockFrequency = Number(clockMatch[1]);
      return;
    }
    const serialMatch = serialStats.exec(input.text);
    if (serialMatch && this.activeMcu) {
      this.activeMcu.serialStats = parseFields(serialMatch[1]);
      return;
    }
    const sendMatch = sendQueue.exec(input.text);
    if (sendMatch && this.activeMcu) {
      this.activeMcu.sendQueueCount = Number(sendMatch[1]);
      this.activeSection = { kind: "mcu-send", mcu: this.activeMcu };
      return;
    }
    const receiveMatch = receiveQueue.exec(input.text);
    if (receiveMatch && this.activeMcu) {
      this.activeMcu.receiveQueueCount = Number(receiveMatch[1]);
      this.activeSection = { kind: "mcu-receive", mcu: this.activeMcu };
      return;
    }
    const gcodeMatch = gcodeDump.exec(input.text);
    if (gcodeMatch) {
      this.activeSection = { kind: "gcode" };
      return;
    }
    if (apiDump.test(input.text)) {
      this.activeSection = { kind: "api" };
      return;
    }
    const stepperMatch = stepperDump.exec(input.text);
    if (stepperMatch) {
      const queue: MutableMotionQueue = {
        count: Number(stepperMatch[3]),
        kind: "stepper",
        line: input.line,
        mcu: stepperMatch[2],
        name: stepperMatch[1],
        samples: [],
      };
      this.active.motionQueues.push(queue);
      this.activeSection = { kind: "motion", queue };
      return;
    }
    const trapqMatch = trapqDump.exec(input.text);
    if (trapqMatch) {
      const queue: MutableMotionQueue = {
        count: Number(trapqMatch[2]),
        kind: "trapq",
        line: input.line,
        mcu: "",
        name: trapqMatch[1],
        samples: [],
      };
      this.active.motionQueues.push(queue);
      this.activeSection = { kind: "motion", queue };
      return;
    }
    this.captureSectionMessage(input);
  }

  finish(sessionNumbers: Map<number, number>) {
    this.finishActive();
    return this.dumps.map((dump) => ({
      ...dump,
      session: sessionNumbers.get(dump.session) ?? dump.session,
    }));
  }

  private start(input: ObserveLine, reason: string) {
    if (this.dumps.length >= this.limits.maxDumps) {
      this.truncation.droppedShutdownDumps += 1;
      this.skippedDump = { session: input.session, source: input.source };
      return;
    }
    this.active = {
      apiRequests: [],
      endLine: input.line,
      gcodeCommands: [],
      line: input.line,
      mcus: [],
      motionQueues: [],
      reason,
      session: input.session,
      source: input.source,
      time: input.time,
    };
    this.activeMcu = null;
    this.activeSection = null;
    this.firstPostDumpStats = null;
  }

  private finishActive() {
    if (this.active) this.dumps.push(this.active);
    this.active = null;
    this.activeMcu = null;
    this.activeSection = null;
    this.firstPostDumpStats = null;
  }

  private captureSectionMessage(input: ObserveLine) {
    if (!this.active || !this.activeSection) return;
    if (this.activeSection.kind === "mcu-send") {
      const match = sentMessage.exec(input.text);
      if (match) this.retain(this.activeSection.mcu.sentMessages, queueMessage(input, match[2], match[3], match[4]));
      return;
    }
    if (this.activeSection.kind === "mcu-receive") {
      const match = receivedMessage.exec(input.text);
      if (match) this.retain(this.activeSection.mcu.receivedMessages, queueMessage(input, match[1], match[3], match[4]));
      return;
    }
    if (this.activeSection.kind === "gcode") {
      const match = gcodeRead.exec(input.text);
      if (match) this.retain(this.active.gcodeCommands, queueMessage(input, match[1], "", match[2]));
      return;
    }
    if (this.activeSection.kind === "api") {
      const match = apiRequest.exec(input.text);
      if (match) this.retain(this.active.apiRequests, queueMessage(input, match[1], "", match[2]));
      return;
    }
    const match = this.activeSection.queue.kind === "stepper"
      ? stepperMessage.exec(input.text)
      : trapqMessage.exec(input.text);
    if (match) this.retain(this.activeSection.queue.samples, queueMessage(input, null, "", input.text));
  }

  private retain(messages: ShutdownQueueMessage[], message: ShutdownQueueMessage) {
    messages.push(message);
    if (messages.length <= this.limits.maxMessagesPerStream) return;
    messages.shift();
    this.truncation.droppedShutdownMessages += 1;
  }
}

function queueMessage(
  input: ObserveLine,
  time: string | null,
  sequence: string,
  text: string,
): ShutdownQueueMessage {
  return {
    line: input.line,
    sequence,
    text: text.slice(0, 1_200),
    time: time === null ? input.time : Number(time),
  };
}

function parseFields(text: string): StatsFields {
  const fields: StatsFields = {};
  for (const part of text.split(/\s+/)) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    const raw = part.slice(separator + 1).replace(/,$/, "");
    const numeric = Number(raw);
    fields[key] = raw !== "" && Number.isFinite(numeric) ? numeric : raw;
  }
  return fields;
}
