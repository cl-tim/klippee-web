import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { analyzeKlippyLog, StreamingKlippyLogAnalyzer } from "./analyzer";
import { analyzeLogFiles } from "./fileAnalyzer";
import { createKlippyHtmlReport } from "./report";

function source(name: string, size = 0, compressed = false) {
  return {
    compressed,
    kind: name.includes("klippy") ? "klippy" as const : name.includes("moonraker") ? "moonraker" as const : "unknown" as const,
    lineCount: 0,
    name,
    size,
  };
}

function fileLike(name: string, bytes: Uint8Array): File {
  return {
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    name,
    size: bytes.byteLength,
  } as File;
}

describe("log diagnostics hardening", () => {
  it("parses signatures split across arbitrary chunks", () => {
    const log = [
      "Start printer at Thu Jul 23 10:00:00 2026 (1 2)",
      "Stats 1.0: heater_bed: target=60 temp=55 pwm=0.5",
      "Transition to shutdown state: ADC out of range",
    ].join("\r\n");
    const expected = analyzeKlippyLog(log, { fileName: "klippy.log" });
    const analyzer = new StreamingKlippyLogAnalyzer();
    analyzer.beginSource(source("klippy.log", log.length));
    for (let index = 0; index < log.length; index += 7) analyzer.pushChunk(log.slice(index, index + 7));
    analyzer.endSource();
    const actual = analyzer.finish();

    expect(actual.lineCount).toBe(expected.lineCount);
    expect(actual.events.map((event) => event.message)).toEqual(expected.events.map((event) => event.message));
    expect(actual.findings.map((finding) => finding.id)).toEqual(expected.findings.map((finding) => finding.id));
  });

  it("bounds samples, events, incidents, names, and oversized lines", () => {
    const lines = Array.from({ length: 30 }, (_, index) =>
      `Stats ${index + 1}.0: mcu: bytes_write=${index} bytes_read=${index} bytes_retransmit=${index} bytes_invalid=0 send_seq=${index} receive_seq=${index} sensor_${index}: temp=20`);
    lines.push(...Array.from({ length: 8 }, (_, index) => `Unable to obtain 'identify' response from mcu_${index}`));
    lines.push("X".repeat(500));
    const analysis = analyzeKlippyLog(lines.join("\n"), {
      limits: {
        maxEvents: 3,
        maxIncidentContexts: 2,
        maxLineLength: 240,
        maxSamplesPerSession: 5,
        maxSensorsPerSession: 2,
      },
    });

    expect(analysis.sessions[0].samples.length).toBeLessThanOrEqual(5);
    expect(analysis.events.length).toBeLessThanOrEqual(3);
    expect(analysis.incidents.length).toBeLessThanOrEqual(2);
    expect(analysis.sessions[0].sensors.length).toBeLessThanOrEqual(2);
    expect(analysis.truncation.droppedSamples).toBeGreaterThan(0);
    expect(analysis.truncation.droppedEvents).toBeGreaterThan(0);
    expect(analysis.truncation.droppedIncidentContexts).toBeGreaterThan(0);
    expect(analysis.truncation.droppedSensorNames).toBeGreaterThan(0);
    expect(analysis.truncation.longLines).toBeGreaterThan(0);
  });

  it("bounds native shutdown dumps and their retained queue messages", () => {
    const analysis = analyzeKlippyLog([
      "Start printer at Thu Jul 23 10:00:00 2026 (1 2)",
      "Transition to shutdown state: Lost communication with MCU 'box'",
      "MCU 'mcu' shutdown: Command request",
      "Dumping send queue 4 messages",
      "Sent 0 10.000000 9.900000 6: seq: 10, first",
      "Sent 1 10.100000 10.000000 6: seq: 11, second",
      "Sent 2 10.200000 10.100000 6: seq: 12, third",
      "Sent 3 10.300000 10.200000 6: seq: 13, fourth",
      "Start printer at Thu Jul 23 11:00:00 2026 (3 4)",
      "Transition to shutdown state: ADC out of range",
      "MCU 'mcu' shutdown: Command request",
    ].join("\n"), {
      limits: {
        maxShutdownDumps: 1,
        maxShutdownMessagesPerStream: 2,
      },
    });

    expect(analysis.shutdownDumps).toHaveLength(1);
    expect(analysis.shutdownDumps[0].mcus[0].sentMessages.map((message) => message.text)).toEqual(["third", "fourth"]);
    expect(analysis.truncation.droppedShutdownMessages).toBe(2);
    expect(analysis.truncation.droppedShutdownDumps).toBe(1);
  });

  it("captures bounded surrounding lines and recent print command context", () => {
    const analysis = analyzeKlippyLog([
      "Virtual sdcard starting position 123",
      "Upcoming (10): G1 X10 Y10",
      "ordinary line before",
      "Transition to shutdown state: Heater heater_bed not heating at expected rate",
      "line after one",
      "line after two",
    ].join("\n"), {
      limits: { incidentAfterLines: 1, incidentBeforeLines: 2 },
    });

    expect(analysis.incidents[0]).toMatchObject({
      after: [{ line: 5, text: "line after one" }],
      anchor: { line: 4 },
      before: [{ line: 2 }, { line: 3 }],
    });
    expect(analysis.incidents[0].commandContext).toEqual([
      "Virtual sdcard starting position 123",
      "Upcoming (10): G1 X10 Y10",
    ]);
  });

  it("combines plain and gzip sources without merging their session context", async () => {
    const klippy = "QIDI Plus4\nStats 1.0: heater_bed: target=60 temp=55 pwm=0.5\n";
    const moonraker = "Moonraker warning\nUnknown command: REMOTE_BAD\n";
    const files = [
      fileLike("klippy.log", strToU8(klippy)),
      fileLike("moonraker.log.gz", gzipSync(strToU8(moonraker))),
    ];
    const progress: string[] = [];
    const analysis = await analyzeLogFiles(files, (update) => progress.push(update.fileName));

    expect(analysis.sources).toMatchObject([
      { compressed: false, kind: "klippy", lineCount: 2, name: "klippy.log" },
      { compressed: true, kind: "moonraker", lineCount: 2, name: "moonraker.log" },
    ]);
    expect(analysis.sessions.map((session) => session.source)).toEqual(["klippy.log", "moonraker.log"]);
    expect(analysis.vendors.map((vendor) => vendor.id)).toContain("qidi");
    expect(analysis.events.find((event) => event.message.includes("REMOTE_BAD"))?.source).toBe("moonraker.log");
    expect(progress).toContain("moonraker.log.gz");
  });

  it("streams Klippee diagnostic ZIP bundles and exposes their capture coverage", async () => {
    const klippy = "QIDI Plus4\nStats 1.0: heater_bed: target=60 temp=55 pwm=0.5\n";
    const moonraker = "Moonraker warning\nUnknown command: REMOTE_BAD\n";
    const manifest = {
      artifacts: [
        {
          archiveName: "logs/klippy.log",
          kind: "klippy-log",
          originalSizeBytes: klippy.length,
          storedSizeBytes: klippy.length,
          truncated: false,
        },
        {
          archiveName: "logs/moonraker.log.gz",
          kind: "moonraker-log",
          originalSizeBytes: moonraker.length,
          storedSizeBytes: moonraker.length,
          truncated: false,
        },
        {
          archiveName: "snapshots/printer-objects.json",
          kind: "moonraker-snapshot",
          originalSizeBytes: 20,
          storedSizeBytes: 20,
          truncated: false,
        },
      ],
      client: { mode: "printer", repositoryId: "repo_1", version: "2026.07.25.1" },
      collectionWarnings: ["Kernel journal was unavailable."],
      generatedAt: "2026-07-25T10:00:00Z",
      schemaVersion: 2,
    };
    const archive = zipSync({
      "logs/klippy.log": strToU8(klippy),
      "logs/moonraker.log.gz": gzipSync(strToU8(moonraker)),
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "snapshots/printer-objects.json": strToU8(JSON.stringify({
        result: {
          status: {
            configfile: {
              save_config_pending: false,
              settings: {
                heater_bed: {
                  max_temp: 120,
                  min_temp: 0,
                  sensor_type: "Generic 3950",
                },
              },
              warnings: [],
            },
            heater_bed: { power: 0.8, target: 60, temperature: 55 },
            print_stats: {
              filename: "fixture.gcode",
              message: "",
              print_duration: 120,
              state: "printing",
              total_duration: 130,
            },
            virtual_sdcard: { progress: 0.4 },
          },
        },
      })),
    });
    const analysis = await analyzeLogFiles([fileLike("klippee-diagnostics.zip", archive)]);

    expect(analysis.sources.map((item) => item.name)).toEqual(["klippy.log", "moonraker.log"]);
    expect(analysis.events.find((event) => event.message.includes("REMOTE_BAD"))?.source).toBe("moonraker.log");
    expect(analysis.bundle).toMatchObject({
      clientVersion: "2026.07.25.1",
      collectionWarnings: ["Kernel journal was unavailable."],
      evidence: {
        config: {
          pendingSave: false,
          retainedSectionCount: 1,
          sectionCount: 1,
        },
        objectCount: 4,
        print: {
          filename: "fixture.gcode",
          progress: 0.4,
          state: "printing",
        },
        sensors: [{
          name: "heater_bed",
          power: 0.8,
          target: 60,
          temperature: 55,
        }],
      },
      generatedAt: "2026-07-25T10:00:00Z",
      schemaVersion: 2,
    });
    expect(analysis.bundle?.artifacts).toHaveLength(3);
    expect(createKlippyHtmlReport(analysis)).toContain("Capture-time Runtime Snapshot");
    expect(createKlippyHtmlReport(analysis)).toContain("Active Klipper Configuration");
  });

  it("skips oversized structured snapshots while preserving analyzable logs", async () => {
    const manifest = {
      artifacts: [
        {
          archiveName: "logs/klippy.log",
          kind: "klippy-log",
          originalSizeBytes: 40,
          storedSizeBytes: 40,
          truncated: false,
        },
        {
          archiveName: "snapshots/printer-objects.json",
          kind: "moonraker-snapshot",
          originalSizeBytes: 4 * 1024 * 1024 + 1_000,
          storedSizeBytes: 4 * 1024 * 1024 + 1_000,
          truncated: false,
        },
      ],
      client: { mode: "printer", repositoryId: "repo_1", version: "test" },
      collectionWarnings: [],
      generatedAt: "2026-07-25T10:00:00Z",
      schemaVersion: 2,
    };
    const archive = zipSync({
      "logs/klippy.log": strToU8("Transition to shutdown state: ADC out of range\n"),
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "snapshots/printer-objects.json": strToU8(JSON.stringify({
        result: { ignored: "x".repeat(4 * 1024 * 1024) },
      })),
    });
    const analysis = await analyzeLogFiles([fileLike("oversized-snapshot.zip", archive)]);

    expect(analysis.findings.map((finding) => finding.id)).toContain("adc-out-of-range");
    expect(analysis.bundle?.evidence?.parseWarnings).toContain(
      "snapshots/printer-objects.json exceeded the browser snapshot analysis limit.",
    );
  });

  it("detects thermal behavior and degrading MCU counters from retained telemetry", () => {
    const analysis = analyzeKlippyLog([
      "Stats 0.0: mcu: bytes_write=1 bytes_read=1 bytes_retransmit=0 bytes_invalid=0 send_seq=1 receive_seq=1 upcoming_bytes=0 heater_bed: target=100 temp=20.0 pwm=1",
      "Stats 30.0: mcu: bytes_write=2 bytes_read=2 bytes_retransmit=10 bytes_invalid=2 send_seq=10 receive_seq=2 upcoming_bytes=9000 heater_bed: target=100 temp=20.0 pwm=1",
      "Stats 60.0: mcu: bytes_write=3 bytes_read=3 bytes_retransmit=20 bytes_invalid=4 send_seq=20 receive_seq=3 upcoming_bytes=10000 heater_bed: target=100 temp=20.1 pwm=1",
    ].join("\n"));

    expect(analysis.findings.map((finding) => finding.id)).toContain("thermal-flatline-heater_bed");
    expect(analysis.findings.map((finding) => finding.id)).toContain("mcu-degradation-mcu");
  });
});
