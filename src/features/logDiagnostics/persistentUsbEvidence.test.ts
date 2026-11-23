import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inferSourceKind, StreamingKlippyLogAnalyzer } from "./analyzer";
import { analyzeLogFiles } from "./fileAnalyzer";
import { parsePersistentUsbRecord } from "./persistentUsbEvidence";

const boot = "11111111-2222-3333-4444-555555555555";
const otherBoot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const klippy = [
  "Start printer at Mon Nov 23 00:00:00 2026 (1800000100.0 100.0)",
  "Stats 126.0: mcu: bytes_write=100 bytes_read=200 bytes_retransmit=0 send_seq=10 receive_seq=10 mcu_box1: bytes_write=100 bytes_read=200 bytes_retransmit=0 send_seq=10 receive_seq=10",
  "Timeout with MCU 'mcu_box1'",
  "Transition to shutdown state: Lost communication with MCU 'mcu_box1'",
  "MCU 'mcu' shutdown: Command request",
  "Dumping serial stats: bytes_write=100 bytes_read=200 bytes_retransmit=0 send_seq=10 receive_seq=10",
].join("\n");

function record(overrides = {}) {
  return { schema: 1, action: "remove", bootId: boot, epoch: 1800000126, monotonic: 126, port: "2-1.3", ids: "1d50/614e/100", ...overrides };
}

function analyze(records: unknown[], usbFirst = false, log = klippy) {
  const analyzer = new StreamingKlippyLogAnalyzer();
  const sources = [["klippy.log", log], ["usb-events.log", records.map((item) => JSON.stringify(item)).join("\n")]];
  for (const [name, text] of usbFirst ? sources.reverse() : sources) {
    analyzer.beginSource({ name, kind: inferSourceKind(name), compressed: false, lineCount: 0, size: text.length });
    // Exercise records split across chunks too.
    analyzer.pushChunk(text.slice(0, 37));
    analyzer.pushChunk(text.slice(37));
    analyzer.endSource();
  }
  return analyzer.finish();
}

function lostFinding(records: unknown[], usbFirst = false, log = klippy) {
  return analyze(records, usbFirst, log).findings.find((finding) => finding.id.startsWith("shutdown-dump-lost-mcu-"));
}

describe("persistent USB evidence", () => {
  it("correlates retained evidence for the earlier boot, independent of source order", () => {
    for (const usbFirst of [false, true]) {
      const finding = lostFinding([record(), record({ bootId: otherBoot, epoch: 1800003726 })], usbFirst);
      expect(finding?.detail).toContain("Persistent USB evidence records a disconnect on usb 2-1.3");
      expect(finding?.detail).toContain("does not establish a power-supply fault");
      expect(finding?.evidence.filter((item) => item.source === "usb-events.log")).toHaveLength(1);
    }
  });

  it("uses monotonic time after a clock change within a uniquely anchored boot", () => {
    const finding = lostFinding([
      record({ action: "start", port: "-", ids: "-", epoch: 1800000100, monotonic: 100 }),
      record({ epoch: 1800009999 }),
    ]);
    expect(finding?.detail).toContain("Persistent USB evidence");
  });

  it("does not link stale, different-boot, ambiguous, add-only or unanchored records", () => {
    for (const records of [
      [record({ monotonic: 10, epoch: 1800000010 })],
      [record({ monotonic: 5000 })],
      [record(), record({ bootId: otherBoot })],
      [record({ action: "add" })],
      [record(), record({ port: "2-1.4" })],
    ]) {
      const finding = lostFinding(records);
      expect(finding).toBeDefined();
      expect(finding?.detail).not.toContain("Persistent USB evidence");
    }
    expect(lostFinding([record()], false, klippy.replace(/^Start printer.*\n/, ""))?.detail).not.toContain("Persistent USB evidence");
  });

  it("rejects malformed, oversized, non-finite, unknown-schema and private fields", () => {
    for (const value of ["broken", "null", "[]", JSON.stringify(record({ schema: 2 })),
      JSON.stringify(record({ port: "<script>" })), JSON.stringify(record({ bootId: "bad" })),
      JSON.stringify(record({ serial: "private" })), JSON.stringify(record({ epoch: null })),
      JSON.stringify(record({ monotonic: -1 })), JSON.stringify(record({ epoch: true })),
      JSON.stringify(record()).replace("1800000126", "1e999"), " ".repeat(1025)]) {
      expect(parsePersistentUsbRecord(value)).toBeNull();
    }
  });

  it("splits the event timeline when boot identity changes and bounds retained records", () => {
    const analysis = analyze([record(), record({ bootId: otherBoot, epoch: 1800003726, monotonic: 1 })]);
    expect(analysis.sessions.filter((session) => session.source === "usb-events.log")).toHaveLength(2);
    const analyzer = new StreamingKlippyLogAnalyzer({ limits: { maxEvents: 2 } });
    analyzer.beginSource({ name: "usb-events.log", kind: "usb", compressed: false, lineCount: 0, size: 0 });
    analyzer.pushChunk(Array.from({ length: 10 }, (_, index) => JSON.stringify(record({ monotonic: index }))).join("\n"));
    const limited = analyzer.finish();
    expect(limited.events.length).toBeLessThanOrEqual(2);
    expect(limited.truncation.droppedEvents).toBe(8);
  });

  it("ingests both retained files from an actual diagnostic ZIP", async () => {
    const archive = zipSync({
      "manifest.json": strToU8(JSON.stringify({ schemaVersion: 2, artifacts: [], collectionWarnings: [] })),
      "logs/klippy.log": strToU8(klippy),
      "logs/usb-events.previous.log": strToU8(JSON.stringify(record())),
      "logs/usb-events.log": strToU8(JSON.stringify(record({ bootId: otherBoot, epoch: 1800003726 }))),
    });
    const file = { name: "diagnostics.zip", size: archive.length, arrayBuffer: async () => new Uint8Array(archive).buffer } as File;
    const analysis = await analyzeLogFiles([file]);
    expect(analysis.sources.filter((source) => source.kind === "usb")).toHaveLength(2);
    expect(analysis.findings.find((item) => item.id.startsWith("shutdown-dump-lost-mcu-"))?.detail).toContain("Persistent USB evidence");
  });
});
