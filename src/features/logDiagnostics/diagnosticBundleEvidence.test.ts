import { describe, expect, it } from "vitest";
import {
  buildDiagnosticBundleFindings,
  parseDiagnosticBundleEvidence,
} from "./diagnosticBundleEvidence";

describe("diagnostic bundle runtime evidence", () => {
  it("normalizes Moonraker snapshots and produces observed findings", () => {
    const temperatures = Array.from({ length: 60 }, (_, index) => 70 - index / 12);
    const snapshots = new Map([
      ["snapshots/server-info.json", JSON.stringify({
        result: {
          failed_components: ["update_manager"],
          klippy_connected: true,
          klippy_state: "shutdown",
          moonraker_version: "v0.9.3-test",
          warnings: ["Deprecated Moonraker option"],
        },
      })],
      ["snapshots/printer-info.json", JSON.stringify({
        result: {
          software_version: "v0.13.0-test",
          state: "shutdown",
          state_message: "Lost communication with MCU 'box'",
        },
      })],
      ["snapshots/printer-objects.json", JSON.stringify({
        result: {
          status: {
            heater_bed: { power: 1, target: 100, temperature: 65.1 },
            print_stats: {
              filename: "failed.gcode",
              message: "MCU shutdown",
              print_duration: 620,
              state: "error",
              total_duration: 700,
            },
            virtual_sdcard: { file_position: 500, file_size: 2_000 },
          },
        },
      })],
      ["snapshots/temperature-store.json", JSON.stringify({
        result: {
          heater_bed: {
            powers: Array(60).fill(1),
            targets: Array(60).fill(100),
            temperatures,
          },
        },
      })],
      ["snapshots/gcode-store.json", JSON.stringify({
        result: {
          gcode_store: [{ message: "G1 X20", time: 1_721_000_000, type: "command" }],
        },
      })],
      ["snapshots/job-history.json", JSON.stringify({
        result: {
          jobs: [{
            end_time: 1_721_000_700,
            filename: "failed.gcode",
            print_duration: 620,
            start_time: 1_721_000_000,
            status: "klippy_shutdown",
            total_duration: 700,
          }],
        },
      })],
      ["snapshots/usb-serial-topology.json", JSON.stringify({
        devices: [{
          byId: "/dev/serial/by-id/usb-Klipper_QIDI_BOX_ABC-if00",
          manufacturer: "Klipper",
          product: "QIDI_BOX_V1_1.1.1",
          productId: "614e",
          serial: "ABC",
          tty: "/dev/ttyACM3",
          usbPath: "2-1.2.1.2",
          vendorId: "1d50",
        }],
      })],
    ]);

    const evidence = parseDiagnosticBundleEvidence(snapshots);
    expect(evidence).toMatchObject({
      objectCount: 3,
      print: {
        filename: "failed.gcode",
        progress: 0.25,
        state: "error",
      },
      printer: {
        softwareVersion: "v0.13.0-test",
        state: "shutdown",
      },
      sensors: [{
        name: "heater_bed",
        power: 1,
        target: 100,
        temperature: 65.1,
      }],
      server: {
        failedComponents: ["update_manager"],
        klippyConnected: true,
        warnings: ["Deprecated Moonraker option"],
      },
    });
    expect(evidence?.thermalHistory[0].temperatures).toHaveLength(60);
    expect(evidence?.gcode[0].message).toBe("G1 X20");
    expect(evidence?.jobs[0].status).toBe("klippy_shutdown");
    expect(evidence?.usbSerialDevices[0]).toMatchObject({
      byId: "/dev/serial/by-id/usb-Klipper_QIDI_BOX_ABC-if00",
      tty: "/dev/ttyACM3",
      usbPath: "2-1.2.1.2",
    });

    const findings = buildDiagnosticBundleFindings(evidence!, 3);
    expect(findings.map((finding) => finding.id)).toEqual([
      "bundle-printer-state",
      "bundle-moonraker-failed-components",
      "bundle-moonraker-warnings",
      "bundle-failed-job",
      "bundle-thermal-heater-bed",
    ]);
    expect(findings.find((finding) => finding.id === "bundle-thermal-heater-bed")?.title)
      .toBe("heater_bed cooled while under high power");
  });

  it("rejects malformed USB serial topology records", () => {
    const evidence = parseDiagnosticBundleEvidence(new Map([
      ["snapshots/usb-serial-topology.json", JSON.stringify({
        devices: [
          { byId: "/tmp/not-stable", tty: "/dev/ttyACM3", usbPath: "2-1" },
          { byId: "/dev/serial/by-id/good", tty: "/dev/sda", usbPath: "2-1" },
          { byId: "/dev/serial/by-id/good", tty: "/dev/ttyACM3", usbPath: "../../etc" },
        ],
      })],
    ]));

    expect(evidence).toBeNull();
  });

  it("reports malformed supported snapshots without discarding valid evidence", () => {
    const evidence = parseDiagnosticBundleEvidence(new Map([
      ["snapshots/server-info.json", "{not json"],
      ["snapshots/printer-info.json", JSON.stringify({ result: { state: "ready" } })],
    ]));

    expect(evidence?.printer?.state).toBe("ready");
    expect(evidence?.parseWarnings).toEqual([
      "snapshots/server-info.json was not valid JSON and could not be analyzed.",
    ]);
  });

  it("parses generic host scheduling evidence and reports latency risk factors", () => {
    const evidence = parseDiagnosticBundleEvidence(new Map([
      ["snapshots/host-scheduling.json", JSON.stringify({
        governors: { policy0: "ondemand" },
        irqbalanceState: "inactive",
        ondemandState: "inactive",
        onlineCpus: "0-3",
        serialIrqs: [
          { device: "ttyS0", effectiveCpuList: "0", irq: 25, requestedCpuList: "0-3" },
          { device: "ttyS2", effectiveCpuList: "0", irq: 27, requestedCpuList: "0-3" },
        ],
        services: [
          { activeState: "active", cpuAffinity: "", cpuAllowedList: "0-3", name: "klipper" },
          { activeState: "active", cpuAffinity: "", cpuAllowedList: "0-3", name: "moonraker" },
        ],
      })],
    ]));

    expect(evidence?.hostScheduling).toMatchObject({
      governors: { policy0: "ondemand" },
      onlineCpus: "0-3",
      serialIrqs: [
        { device: "ttyS0", effectiveCpuList: "0", irq: 25 },
        { device: "ttyS2", effectiveCpuList: "0", irq: 27 },
      ],
    });
    const finding = buildDiagnosticBundleFindings(evidence!, 1)
      .find((item) => item.id === "bundle-host-scheduling-risk");
    expect(finding?.detail).toContain("policy0=ondemand");
    expect(finding?.detail).toContain("multiple serial IRQs were effective only on CPU list 0");
    expect(finding?.checks.join(" ")).toContain("different board");
  });
});
