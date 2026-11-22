import { describe, expect, it } from "vitest";
import { analyzeKlippyLog, StreamingKlippyLogAnalyzer } from "./analyzer";
import { createKlippyHtmlReport } from "./report";

function stats(time: number, boxRead: number, boxReceive: number, mainReceive: number) {
  return `Stats ${time.toFixed(1)}: gcodein=0  mcu: bytes_write=100 bytes_read=200 bytes_retransmit=9 bytes_invalid=0 send_seq=${mainReceive} receive_seq=${mainReceive} upcoming_bytes=0 mcu_box: bytes_write=300 bytes_read=${boxRead} bytes_retransmit=9 bytes_invalid=0 send_seq=${boxReceive} receive_seq=${boxReceive} upcoming_bytes=0 heater_bed: target=60 temp=55.0 pwm=0.5 sysload=1.2 memavail=524288 buffer_time=2.0`;
}

describe("Klippy log analyzer", () => {
  it.each([
    "No trigger on probe after full movement",
    "Homing failed: No trigger on probe after full movement",
    "Error on 'QUAD_GANTRY_LEVEL': No trigger on probe after full movement",
  ])("identifies the probe travel failure instead of an axis endstop fault: %s", (message) => {
    const analysis = analyzeKlippyLog(`${message}\n`);
    expect(analysis.findings.map((finding) => finding.id)).toContain("probe-no-trigger");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("homing-failure");
    expect(analysis.summary.title).toContain("Probe did not trigger within its travel");
  });

  it("surfaces the probe fault ahead of the generic failed-print outcome", () => {
    const analysis = analyzeKlippyLog([
      "Starting SD card print (position 0)",
      "No trigger on probe after full movement",
      "Exiting SD card print (position 0)",
    ].join("\n"));
    expect(analysis.summary.findingId).toBe("probe-no-trigger");
    expect(analysis.summary.detail).not.toContain("No explicit Klipper shutdown or print-stop reason");
  });

  it("does not let an earlier probe failure hide a later fault", () => {
    const analysis = analyzeKlippyLog([
      "Start printer at Wed Nov 4 10:00:00 2026 (1 2)",
      "No trigger on probe after full movement",
      "Restarting printer",
      "Start printer at Wed Nov 4 10:05:00 2026 (3 4)",
      "Move out of range: 400.000 20.000 2.000",
    ].join("\n"));
    expect(analysis.summary.findingId).toBe("move-out-of-range");
  });

  it.each([
    ["b'Got error -1 in write: (19)No such device'", "usb-device-loss"],
    ["CANBUS error: bus-off detected", "canbus-failure"],
    ["Transition to shutdown state: Timer too close", "mcu-scheduling"],
    ["MCU 'mcu' shutdown: Move queue overflow", "mcu-scheduling"],
    ["Unable to obtain 'identify' response", "mcu-communication-loss"],
    ["MCU Protocol error", "firmware-protocol"],
    ["MCU 'mcu' CRC does not match config", "mcu-configuration-failure"],
    ["Unable to configure MCU 'toolhead'", "mcu-configuration-failure"],
    ["Transition to shutdown state: Heater extruder not heating at expected rate", "heater-not-heating"],
    ["Transition to shutdown state: ADC out of range", "adc-out-of-range"],
    ["Requested temperature (500.0) out of range (0.0:300.0)", "thermal-limit"],
    ["COMBINED SENSOR maximum deviation exceeded limit of 5.0", "combined-sensor-deviation"],
    ["Homing failed: No trigger on x after full movement", "homing-failure"],
    ["Must home axis first: 0.000 0.000 10.000", "axis-not-homed"],
    ["Probe samples exceed samples_tolerance", "probe-failure"],
    ["Unable to detect tap: timeout", "eddy-probe-failure"],
    ["Too many retries", "bed-mesh-failure"],
    ["TMC 'stepper_x' reports error: DRV_STATUS: 001f0000 ot=1", "tmc-driver-failure"],
    ["Unable to write tmc uart 'stepper_x' register GCONF", "tmc-driver-failure"],
    ["Move out of range: 400.000 20.000 2.000", "move-out-of-range"],
    ["Section 'mcu extra' is not a valid config section", "config-invalid"],
    ["Option 'serial' in section 'mcu' must be specified", "config-invalid"],
    ["Include file 'missing.cfg' does not exist", "config-invalid"],
    ["SAVE_CONFIG section 'probe' option 'z_offset' conflicts with included value", "save-config-failure"],
    ["AttributeError: 'ToolChange' object has no attribute 'is_tool_change'", "python-exception"],
    ["Adapter更新状态异常: 'ToolChange' object has no attribute 'is_tool_change'", "qidi-toolchange-adapter-mismatch"],
    ["Invalid adxl345 id (got 0 vs e5)", "sensor-chip-failure"],
    ["Filament Sensor toolhead: runout event detected, Time 123.4", "filament-runout"],
    ["virtual_sdcard error: Unable to open file", "virtual-sd-failure"],
    ["Unable to get file list", "virtual-sd-failure"],
    ["MCU shutdown: brownout reset cause", "power-reset"],
  ])("classifies %s", (line, expectedId) => {
    const analysis = analyzeKlippyLog(`${line}\n`);
    expect(analysis.findings.map((finding) => finding.id)).toContain(expectedId);
  });

  it("does not mislabel thermal shutdowns as communication failures", () => {
    const analysis = analyzeKlippyLog("Transition to shutdown state: Heater extruder not heating at expected rate\n");
    expect(analysis.findings.map((finding) => finding.id)).toContain("heater-not-heating");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("mcu-communication-loss");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("unclassified-shutdown");
  });

  it("does not infer a CAN failure from unrelated words in a Moonraker subscription payload", () => {
    const analysis = analyzeKlippyLog(
      `Received 54.2: b'{"method":"objects/subscribe","params":{"objects":{"canbus_stats EBBCan":null,"led_effect sb_critical_error":null}}}'`,
    );

    expect(analysis.findings.map((finding) => finding.id)).not.toContain("canbus-failure");
  });

  it("correlates a Shake&Tune sweep and host write backpressure with a scheduling shutdown", () => {
    const analysis = analyzeKlippyLog([
      "Shake&Tune version: v5.2.1",
      `Received 78.3: b'{"method":"gcode/script","params":{"script":"COMPARE_BELTS_RESPONSES"}}'`,
      "Stats 280.0: mcu: bytes_write=100 bytes_read=200 bytes_retransmit=0 bytes_invalid=0 send_seq=40 receive_seq=40 ready_bytes=0 upcoming_bytes=0 CB1: temp=66.2 sysload=1.8 memavail=68000",
      "Testing frequency: 39.0 Hz",
      "b'Got error -1 in write: (11) Resource temporarily unavailable'",
      "MCU 'mcu' shutdown: Timer too close",
      "Transition to shutdown state: MCU shutdown",
      "serialhdl.error: Unable to obtain 'sensor_bulk_status' response",
      "b'Got EOF when reading from device'",
    ].join("\n"));

    const finding = analysis.findings.find((item) => item.id === "shaketune-scheduling-pressure");
    expect(finding?.confidence).toBe("high");
    expect(finding?.detail).toContain("COMPARE_BELTS_RESPONSES");
    expect(finding?.detail).toContain("39.0 Hz");
    expect(finding?.detail).toContain("Resource temporarily unavailable");
    expect(finding?.detail).toContain("66.2");
    expect(analysis.summary.findingId).toBe("shaketune-scheduling-pressure");
    expect(analysis.findings.find((item) => item.id === "mcu-communication-loss")?.severity).toBe("warning");
    expect(analysis.findings.find((item) => item.id === "usb-device-loss")?.severity).toBe("warning");
  });

  it("correlates Timer too close with pre-shutdown UART degradation and excludes shutdown fallout", () => {
    const analysis = analyzeKlippyLog([
      "===== Config file =====",
      "[mcu]",
      "serial = /dev/ttyS2",
      "[mcu U_1]",
      "serial = /dev/ttyS0",
      "=======================",
      "TMC 'stepper_x' reports error: DRV_STATUS: 00000001 uv_cp=1",
      "TMC 'stepper_x' reports GSTAT: 00000000",
      "File opened:latency-test.gcode Size:10000",
      "Starting SD card print (position 0)",
      "Stats 100.0: mcu: bytes_write=100 bytes_read=200 bytes_retransmit=9 bytes_invalid=0 send_seq=40 receive_seq=40 upcoming_bytes=0 U_1: bytes_write=100 bytes_read=200 bytes_retransmit=0 bytes_invalid=0 send_seq=30 receive_seq=30 upcoming_bytes=0 CB1: temp=39.0 sysload=1.08 memavail=708608 cputime=10.0",
      "Stats 220.0: mcu: bytes_write=200 bytes_read=300 bytes_retransmit=116 bytes_invalid=0 send_seq=80 receive_seq=79 upcoming_bytes=0 U_1: bytes_write=200 bytes_read=300 bytes_retransmit=0 bytes_invalid=0 send_seq=60 receive_seq=60 upcoming_bytes=0 CB1: temp=39.5 sysload=1.10 memavail=706560 cputime=11.0",
      "MCU 'mcu' shutdown: Timer too close",
      "Transition to shutdown state: MCU 'mcu' shutdown: Timer too close",
      "Stats 221.0: mcu: bytes_write=210 bytes_read=300 bytes_retransmit=317 bytes_invalid=0 send_seq=90 receive_seq=79 upcoming_bytes=0 U_1: bytes_write=210 bytes_read=300 bytes_retransmit=122 bytes_invalid=0 send_seq=70 receive_seq=60 upcoming_bytes=0 CB1: temp=39.5 sysload=1.09 memavail=706000 cputime=11.1",
      "MCU 'U_1' shutdown: Shutdown due to command request",
    ].join("\n"));

    const finding = analysis.findings.find((item) => item.id === "mcu-scheduling-latency-correlation");
    expect(finding?.confidence).toBe("high");
    expect(finding?.detail).toContain("mcu (/dev/ttyS2)");
    expect(finding?.detail).toContain("107 retransmitted");
    expect(finding?.detail).toContain("transient host, IRQ, or serial scheduling delay");
    expect(analysis.summary.findingId).toBe("mcu-scheduling-latency-correlation");

    const mcu = analysis.sessions[0].mcus.find((item) => item.name === "mcu");
    expect(mcu).toMatchObject({
      postShutdownRetransmittedBytesDelta: 201,
      preShutdownRetransmittedBytesDelta: 107,
      retransmittedBytesDelta: 308,
    });
    expect(analysis.findings.map((item) => item.id)).toContain("tmc-startup-status-cleared");
    expect(analysis.findings.map((item) => item.id)).not.toContain("tmc-driver-failure");
    expect(analysis.findings.map((item) => item.id)).not.toContain("power-reset");
    expect(analysis.findings.find((item) => item.id === "serial-quality")?.severity).toBe("warning");
  });

  it.each([
    [
      "TimeoutError: Shake&Tune was unable to retrieve accelerometer data in time. This might be due to slow hardware or a busy system.",
      "shaketune-data-timeout",
      "Shake&Tune accelerometer retrieval timed out",
    ],
    [
      "TimeoutError: Shake&Tune was unable to finish and close the .stdata writing process. This might be due to a slow, busy or full SD card.",
      "shaketune-storage-failure",
      "Shake&Tune could not finalize its result data",
    ],
    [
      "Shake&Tune was unable to create the final data file (/config/result.stdata): [Errno 18] Invalid cross-device link: '/tmp/result.stdata' -> '/config/result.stdata'",
      "shaketune-storage-failure",
      "Shake&Tune could not finalize its result data",
    ],
  ])("diagnoses the explicit Shake&Tune failure in %s", (message, id, title) => {
    const analysis = analyzeKlippyLog([
      "Shake&Tune version: v5.0.0",
      message,
      `Transition to shutdown state: Internal error on command:"_CREATE_VIBRATIONS_PROFILE"`,
    ].join("\n"));

    expect(analysis.findings.map((finding) => finding.id)).toContain(id);
    expect(analysis.summary.findingId).toBe(id);
    expect(analysis.summary.title).toContain(title);
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("canbus-failure");
  });

  it("does not treat startup zeroes or inactive one-degree targets as thermal faults", () => {
    const analysis = analyzeKlippyLog([
      "Stats 1.0: EBB_NTC: temp=0 heater_bed: target=1 temp=23 pwm=0",
      "Stats 2.0: EBB_NTC: temp=33.8 heater_bed: target=1 temp=23 pwm=0",
    ].join("\n"));

    expect(analysis.findings.map((finding) => finding.id)).not.toContain("thermal-jump-EBB_NTC");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("thermal-overshoot-heater_bed");
  });

  it("treats a missing home as a command-state error instead of critical homing hardware failure", () => {
    const analysis = analyzeKlippyLog("Must home axis first: 0.000 0.000 10.000\n");
    expect(analysis.findings.find((finding) => finding.id === "axis-not-homed")?.severity).toBe("error");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("homing-failure");
  });

  it("distinguishes a requested emergency stop from an unclassified hardware shutdown", () => {
    const analysis = analyzeKlippyLog("Transition to shutdown state: Shutdown due to M112 command\n");
    expect(analysis.findings.map((finding) => finding.id)).toContain("requested-shutdown");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("unclassified-shutdown");
    expect(analysis.summary.title).toContain("emergency or remote shutdown requested");
  });

  it("correlates completed, paused, resumed, failed, and interrupted virtual SD prints", () => {
    const analysis = analyzeKlippyLog([
      "Start printer at Thu Jul 23 10:00:00 2026 (1 2)",
      "File opened:first.gcode Size:1000",
      "File selected",
      "Starting SD card print (position 0)",
      "Finished SD card print",
      "Done printing file",
      "Exiting SD card print (position 1000)",
      "File opened:second.gcode Size:2000",
      "File selected",
      "Starting SD card print (position 0)",
      "Filament Sensor toolhead: runout event detected, Time 20.0",
      "Exiting SD card print (position 500)",
      "Starting SD card print (position 500)",
      "Unknown command: BAD_PRINT_COMMAND",
      "Exiting SD card print (position 750)",
      "File opened:third.gcode Size:4000",
      "Starting SD card print (position 0)",
      "Restarting printer",
      "Start printer at Thu Jul 23 10:10:00 2026 (3 4)",
      "Stats 1.0: sysload=0.2 memavail=524288",
    ].join("\n"));

    expect(analysis.prints).toHaveLength(3);
    expect(analysis.prints[0]).toMatchObject({
      fileName: "first.gcode",
      outcome: "complete",
      progress: 1,
    });
    expect(analysis.prints[1]).toMatchObject({
      endPosition: 750,
      fileName: "second.gcode",
      outcome: "failed",
      progress: 0.375,
      reason: "Unknown command: BAD_PRINT_COMMAND",
    });
    expect(analysis.prints[2]).toMatchObject({
      fileName: "third.gcode",
      outcome: "interrupted",
    });
    expect(analysis.findings.map((finding) => finding.id)).toContain("filament-runout");
    expect(analysis.findings.some((finding) => finding.id.startsWith("print-failed-"))).toBe(true);
    expect(analysis.findings.some((finding) => finding.id.startsWith("print-interrupted-"))).toBe(true);
  });

  it("does not claim an outcome when the supplied log ends during an active print", () => {
    const analysis = analyzeKlippyLog([
      "File opened:still-printing.gcode Size:1000",
      "Starting SD card print (position 100)",
      "Stats 5.0: sysload=0.2 memavail=524288",
    ].join("\n"));

    expect(analysis.prints[0]).toMatchObject({ outcome: "unknown", progress: null });
    expect(analysis.findings.some((finding) => finding.id.startsWith("print-interrupted-"))).toBe(false);
  });

  it("records a print failure when shutdown occurs before virtual SD can log its exit", () => {
    const analysis = analyzeKlippyLog([
      "File opened:thermal-failure.gcode Size:1000",
      "Starting SD card print (position 0)",
      "Transition to shutdown state: Heater extruder not heating at expected rate",
    ].join("\n"));

    expect(analysis.prints[0]).toMatchObject({
      outcome: "failed",
      reason: "Transition to shutdown state: Heater extruder not heating at expected rate",
    });
  });

  it("does not treat the virtual SD on_error status field as an I/O failure", () => {
    const analysis = analyzeKlippyLog("virtual_sdcard on_error\n");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("virtual-sd-failure");
  });

  it("keeps an unfamiliar shutdown explicitly unclassified", () => {
    const analysis = analyzeKlippyLog("Transition to shutdown state: Unexpected flux instability\n");
    const finding = analysis.findings.find((item) => item.id === "unclassified-shutdown");
    expect(finding?.detail).toBe("Unexpected flux instability");
    expect(finding?.confidence).toBe("observed");
  });

  it("surfaces a localized QIDI ToolChange mismatch as the strongest clue without inventing a print-stop cause", () => {
    const adapterFailure = "Adapter更新状态异常: 'ToolChange' object has no attribute 'is_tool_change'";
    const log = [
      "Start printer at Thu Jul 23 10:17:18 2026 (1 2)",
      stats(37, 100, 1, 1),
      ...Array.from({ length: 12 }, () => adapterFailure),
      "Restarting printer",
      "Start printer at Thu Jul 23 10:18:01 2026 (3 4)",
      stats(5, 10, 1, 1),
    ].join("\n");
    const analysis = analyzeKlippyLog(log);

    expect(analysis.sessions).toHaveLength(2);
    expect(analysis.sessions[0]).toMatchObject({ endLine: 15, startLine: 1 });
    expect(analysis.sessions[1]).toMatchObject({ endLine: 17, startLine: 16 });
    expect(analysis.findings.map((finding) => finding.id)).toContain("qidi-toolchange-adapter-mismatch");
    expect(analysis.findings.filter((finding) => finding.id === "python-exception")).toHaveLength(0);
    expect(analysis.summary.title).toContain("QIDI Box tool-change components are incompatible");
    expect(analysis.summary.detail).toContain("No explicit Klipper shutdown or print-stop reason was recorded");
    expect(analysis.summary.tone).toBe("clue");
  });

  it("identifies a fully powered heater that falls farther below a stable target", () => {
    const analysis = analyzeKlippyLog([
      "Start printer at Thu Jul 23 09:17:19 2026 (1 2)",
      "Stats 2775.9: heater_bed: target=100 temp=93.2 pwm=1.000 print_time=2616.136 buffer_time=0.000",
      "Stats 2790.0: heater_bed: target=100 temp=92.7 pwm=1.000 print_time=2616.136 buffer_time=0.000",
      "Stats 2804.0: heater_bed: target=100 temp=92.1 pwm=1.000 print_time=2616.136 buffer_time=0.000",
      "Restarting printer",
    ].join("\n"));

    const finding = analysis.findings.find((item) => item.id === "heater-target-not-tracking-heater_bed");
    expect(finding?.title).toBe("heater_bed could not hold its requested temperature");
    expect(finding?.detail).toContain("fell from 93.2 °C to 92.1 °C over 28 seconds");
    expect(finding?.evidence).toHaveLength(2);
    expect(analysis.summary.findingId).toBe("heater-target-not-tracking-heater_bed");
  });

  it("tracks sessions, MCU stalls, counter changes, sensors, and repeated messages", () => {
    const repeated = "AttributeError: status object has no attribute 'ready'";
    const first = [
      "===== Config file =====",
      "[mcu mcu_box]",
      "serial = /dev/serial/by-id/usb-box",
      "=======================",
      stats(10, 1000, 20, 20),
      stats(11, 1100, 21, 21),
      ...Array.from({ length: 12 }, () => repeated),
      "b'Got EOF when reading from device'",
      stats(12, 1100, 21, 22),
      stats(16, 1100, 21, 26),
      "Transition to shutdown state: Lost communication with MCU 'mcu_box'",
      stats(17, 1100, 21, 27),
    ].join("\n");
    const second = ["Start printer at Fri Jul 17 09:17:19 2026 (1 2)", stats(5, 10, 1, 1)].join("\n");
    const analysis = analyzeKlippyLog(`${first}\0${second}`, { byteSize: 1234, fileName: "joined.log" });

    expect(analysis.sessions).toHaveLength(2);
    expect(analysis.sessions[0].mcus.find((mcu) => mcu.name === "mcu_box")?.serialPath).toBe("/dev/serial/by-id/usb-box");
    expect(analysis.sessions[0].mcus.find((mcu) => mcu.name === "mcu_box")?.stalledForSeconds).toBeGreaterThanOrEqual(6);
    expect(analysis.sessions[0].sensors.find((sensor) => sensor.name === "heater_bed")?.maximum).toBe(55);
    expect(analysis.events.find((event) => event.message === repeated)?.count).toBe(12);
    expect(analysis.findings.map((finding) => finding.id)).toContain("mcu-counter-stall");
    expect(analysis.findings.some((finding) => finding.title === "High-frequency recurring message")).toBe(true);
    expect(analysis.sessions[1].wallTime).toBe("Fri Jul 17 09:17:19 2026");
  });

  it("captures temperature readings embedded in MCU telemetry", () => {
    const analysis = analyzeKlippyLog(
      "Stats 1.0: beacon: bytes_write=10 bytes_read=20 bytes_retransmit=0 bytes_invalid=0 send_seq=1 receive_seq=1 coil_temp=41.9 mcu_temp=42.8 supply_voltage=3.004",
    );

    expect(analysis.sessions[0].mcus.find((mcu) => mcu.name === "beacon")).toBeDefined();
    expect(analysis.sessions[0].sensors.find((sensor) => sensor.name === "beacon coil_temp")?.final).toBe(41.9);
    expect(analysis.sessions[0].sensors.find((sensor) => sensor.name === "beacon mcu_temp")?.final).toBe(42.8);
  });

  it("reconstructs native shutdown dumps and isolates a non-responding MCU", () => {
    const analysis = analyzeKlippyLog([
      "Stats 1416.6: mcu: bytes_write=9832 bytes_read=274733 bytes_retransmit=9 bytes_invalid=0 send_seq=1536 receive_seq=1536 mcu_box1: bytes_write=289296 bytes_read=295799 bytes_retransmit=9 bytes_invalid=0 send_seq=21424 receive_seq=21424 U_1: bytes_write=143240 bytes_read=548450 bytes_retransmit=9 bytes_invalid=0 send_seq=10475 receive_seq=10475",
      "Transition to shutdown state: Lost communication with MCU 'mcu_box1'",
      "Dumping gcode input 1 blocks",
      "Read 1416.400000: 'G1 X95 Y324\\n'",
      "Dumping 1 requests for client 1234",
      "Received 1416.450000: {\"method\":\"objects/query\"}",
      "MCU 'U_1' shutdown: Shutdown due to command request",
      "clocksync state: mcu_freq=84000000 clock_est=(1387.559 116981412446 84003328.762)",
      "Dumping serial stats: bytes_write=143246 bytes_read=548462 bytes_retransmit=9 bytes_invalid=0 send_seq=10476 receive_seq=10476",
      "Dumping send queue 2 messages",
      "Sent 0 1416.100000 1416.090000 6: seq: 18, get_clock",
      "Sent 1 1416.200000 1416.190000 14: seq: 19, tmcuart_send oid=2",
      "Dumping receive queue 2 messages",
      "Receive: 0 1416.120000 1416.110000 8: seq: 19, clock clock=1234",
      "Receive: 1 1416.220000 1416.210000 8: seq: 1a, analog_in_state oid=3",
      "MCU 'mcu' shutdown: Command request",
      "Dumping serial stats: bytes_write=9849 bytes_read=274745 bytes_retransmit=9 bytes_invalid=0 send_seq=1537 receive_seq=1537",
      "Dumping send queue 1 messages",
      "Sent 0 1416.300000 1416.290000 6: seq: 11, get_clock",
      "Dumping receive queue 1 messages",
      "Receive: 0 1416.320000 1416.310000 8: seq: 12, clock clock=5678",
    ].join("\n"));

    expect(analysis.shutdownDumps).toHaveLength(1);
    expect(analysis.shutdownDumps[0]).toMatchObject({
      reason: "Lost communication with MCU 'mcu_box1'",
      gcodeCommands: [{ text: "'G1 X95 Y324\\n'" }],
      mcus: [
        {
          clockFrequency: 84_000_000,
          name: "U_1",
          reason: "Shutdown due to command request",
          receiveQueueCount: 2,
          sendQueueCount: 2,
          serialStats: { receive_seq: 10476, send_seq: 10476 },
        },
        {
          name: "mcu",
          reason: "Command request",
          receiveQueueCount: 1,
          sendQueueCount: 1,
        },
      ],
    });
    expect(analysis.shutdownDumps[0].mcus[0].sentMessages.at(-1)).toMatchObject({
      sequence: "19",
      text: "tmcuart_send oid=2",
      time: 1416.19,
    });
    const finding = analysis.findings.find((item) => item.id === "shutdown-dump-lost-mcu-1");
    expect(finding?.title).toBe("mcu_box1 was the non-responding MCU");
    expect(finding?.confidence).toBe("high");
    expect(finding?.detail).toContain("U_1, mcu remained reachable");
    const report = createKlippyHtmlReport(analysis);
    expect(report).toContain("Native Shutdown Reconstruction");
    expect(report).toContain("Did not return a dump");
  });

  it("treats an emergency-stopped responding MCU as fallout and retains matching kernel USB evidence", () => {
    const analyzer = new StreamingKlippyLogAnalyzer();
    analyzer.beginSource({ compressed: false, kind: "klippy", lineCount: 0, name: "klippy.log", size: 0 });
    analyzer.pushChunk([
      "Start printer at Thu Aug  6 09:14:00 2026 (1786007640.0 124760.0)",
      "Stats 124786.1: mcu: bytes_write=9832 bytes_read=274733 bytes_retransmit=9 bytes_invalid=0 send_seq=1536 receive_seq=1536 mcu_box1: bytes_write=289296 bytes_read=295799 bytes_retransmit=9 bytes_invalid=0 send_seq=21424 receive_seq=21424 beacon: bytes_write=143240 bytes_read=548450 bytes_retransmit=9 bytes_invalid=0 send_seq=10475 receive_seq=10475",
      "MCU 'mcu_box1' retransmitted bytes increased by 50 (9 to 59)",
      "b'Got EOF when reading from device'",
      "Timeout with MCU 'mcu_box1'",
      "Transition to shutdown state: Lost communication with MCU 'mcu_box1'",
      "MCU 'beacon' shutdown: Emergency stop",
      "Dumping serial stats: bytes_write=143246 bytes_read=548462 bytes_retransmit=9 bytes_invalid=0 send_seq=10476 receive_seq=10476",
      "MCU 'mcu' shutdown: Command request",
      "Dumping serial stats: bytes_write=9849 bytes_read=274745 bytes_retransmit=9 bytes_invalid=0 send_seq=1537 receive_seq=1537",
    ].join("\n"));
    analyzer.endSource();
    analyzer.beginSource({ compressed: false, kind: "kernel", lineCount: 0, name: "kernel-journal.log", size: 0 });
    analyzer.pushChunk([
      "2026-08-06T09:14:26+0000 example1 kernel: usb 2-1.2.1.2: USB disconnect, device number 22",
      "2026-08-06T09:14:29+0000 example1 kernel: usb 2-1.2.1.2: USB disconnect, device number 23",
    ].join("\n"));
    analyzer.endSource();

    const analysis = analyzer.finish();
    const lostMcu = analysis.findings.find((item) => item.id === "shutdown-dump-lost-mcu-1");

    expect(analysis.findings.some((item) => item.id.startsWith("shutdown-dump-mcu-reason-beacon"))).toBe(false);
    expect(lostMcu?.detail).toContain("beacon (Emergency stop)");
    expect(lostMcu?.detail).toContain("kernel USB-disconnect records for usb 2-1.2.1.2");
    expect(lostMcu?.evidence.filter((item) => item.source === "kernel-journal.log")).toHaveLength(2);
  });

  it("does not attach stale kernel USB evidence from the same topology path", () => {
    const analyzer = new StreamingKlippyLogAnalyzer();
    analyzer.beginSource({ compressed: false, kind: "klippy", lineCount: 0, name: "klippy.log", size: 0 });
    analyzer.pushChunk([
      "Start printer at Thu Aug  6 09:14:00 2026 (1786007640.0 124760.0)",
      "Stats 124786.1: mcu: bytes_write=9832 bytes_read=274733 bytes_retransmit=9 bytes_invalid=0 send_seq=1536 receive_seq=1536 mcu_box1: bytes_write=289296 bytes_read=295799 bytes_retransmit=9 bytes_invalid=0 send_seq=21424 receive_seq=21424",
      "Timeout with MCU 'mcu_box1'",
      "Transition to shutdown state: Lost communication with MCU 'mcu_box1'",
      "MCU 'mcu' shutdown: Command request",
      "Dumping serial stats: bytes_write=9849 bytes_read=274745 bytes_retransmit=9 bytes_invalid=0 send_seq=1537 receive_seq=1537",
    ].join("\n"));
    analyzer.endSource();
    analyzer.beginSource({ compressed: false, kind: "kernel", lineCount: 0, name: "kernel-journal.log", size: 0 });
    analyzer.pushChunk("2026-08-06T08:14:26+0000 example1 kernel: usb 2-1.2.1.2: USB disconnect, device number 12");
    analyzer.endSource();

    const analysis = analyzer.finish();
    const lostMcu = analysis.findings.find((item) => item.id === "shutdown-dump-lost-mcu-1");

    expect(lostMcu?.detail).not.toContain("kernel USB-disconnect");
    expect(lostMcu?.evidence.some((item) => item.source === "kernel-journal.log")).toBe(false);
  });

  it("escapes log content in exported HTML", () => {
    const analysis = analyzeKlippyLog("AttributeError: <script>alert(1)</script>\n", { fileName: "unsafe.log" });
    const report = createKlippyHtmlReport(analysis);
    expect(report).not.toContain("<script>alert(1)</script>");
    expect(report).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(report).toContain("Event Timeline");
  });
});
