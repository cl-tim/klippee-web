import { strToU8, zipSync } from "fflate";

/**
 * Build a deterministic, local-only Klippee diagnostic bundle for responsive
 * UI screenshots. The log contains two sessions so every diagnostics tab,
 * including comparison, has useful data to render.
 */
export function createDiagnosticBundleFixture() {
  const log = [
    "Start printer at Thu Jul 23 10:00:00 2026 (1 2)",
    "Stats 1.0: gcodein=0 mcu: bytes_write=100 bytes_read=200 bytes_retransmit=0 bytes_invalid=0 send_seq=1 receive_seq=1 upcoming_bytes=0 heater_bed: target=60 temp=56 pwm=1.0 sysload=0.4 memavail=524288 buffer_time=2.0",
    "Stats 2.0: gcodein=0 mcu: bytes_write=110 bytes_read=220 bytes_retransmit=0 bytes_invalid=0 send_seq=2 receive_seq=2 upcoming_bytes=0 heater_bed: target=60 temp=52 pwm=1.0 sysload=0.5 memavail=520000 buffer_time=2.0",
    "Stats 3.0: gcodein=0 mcu: bytes_write=120 bytes_read=240 bytes_retransmit=0 bytes_invalid=0 send_seq=3 receive_seq=3 upcoming_bytes=0 heater_bed: target=60 temp=48 pwm=1.0 sysload=0.6 memavail=518000 buffer_time=2.0",
    "File opened:failed.gcode Size:1000",
    "Starting SD card print (position 0)",
    "Unknown command: BAD_PRINT_COMMAND",
    "Transition to shutdown state: Lost communication with MCU 'box'",
    "Restarting printer",
    "Start printer at Thu Jul 23 10:10:00 2026 (3 4)",
    "Stats 1.0: gcodein=0 mcu: bytes_write=100 bytes_read=200 bytes_retransmit=0 bytes_invalid=0 send_seq=1 receive_seq=1 upcoming_bytes=0 heater_bed: target=60 temp=58 pwm=0.5 sysload=0.2 memavail=600000 buffer_time=2.0",
    "Stats 2.0: gcodein=0 mcu: bytes_write=110 bytes_read=220 bytes_retransmit=0 bytes_invalid=0 send_seq=2 receive_seq=2 upcoming_bytes=0 heater_bed: target=60 temp=57 pwm=0.5 sysload=0.2 memavail=600000 buffer_time=2.0",
  ].join("\n");

  const contents = {
    "logs/klippy.log": log,
    "snapshots/gcode-store.json": JSON.stringify({
      result: { gcode_store: [{ message: "G1 X20", time: 1_721_000_000, type: "command" }] },
    }),
    "snapshots/job-history.json": JSON.stringify({
      result: { jobs: [{ filename: "failed.gcode", print_duration: 120, start_time: 1_721_000_000, status: "klippy_shutdown", total_duration: 140 }] },
    }),
    "snapshots/printer-info.json": JSON.stringify({
      result: { software_version: "v0.13-smoke", state: "shutdown", state_message: "Lost communication with MCU 'box'" },
    }),
    "snapshots/printer-objects.json": JSON.stringify({
      result: {
        status: {
          configfile: {
            save_config_pending: true,
            save_config_pending_items: { heater_bed: { pid_kp: "changed" } },
            settings: {
              heater_bed: { control: "pid", max_temp: 120, min_temp: 0, sensor_type: "Generic 3950" },
              "mcu box": { restart_method: "command", serial: "/dev/serial/by-id/usb-box" },
            },
            warnings: [{ message: "Synthetic config warning", type: "deprecated_option" }],
          },
          heater_bed: { power: 1, target: 60, temperature: 48 },
          print_stats: { filename: "failed.gcode", message: "MCU shutdown", print_duration: 120, state: "error", total_duration: 140 },
          virtual_sdcard: { progress: 0.6 },
        },
      },
    }),
    "snapshots/server-info.json": JSON.stringify({
      result: { failed_components: ["update_manager"], klippy_connected: true, klippy_state: "shutdown", moonraker_version: "v0.9-smoke", warnings: ["Synthetic Moonraker warning"] },
    }),
    "snapshots/temperature-store.json": JSON.stringify({
      result: { heater_bed: { powers: [1, 1, 1], targets: [60, 60, 60], temperatures: [56, 52, 48] } },
    }),
  };

  const artifacts = Object.entries(contents).map(([archiveName, content]) => {
    const storedSizeBytes = Buffer.byteLength(content);
    return {
      archiveName,
      kind: archiveName.startsWith("logs/") ? "klippy-log" : "moonraker-snapshot",
      originalSizeBytes: storedSizeBytes,
      storedSizeBytes,
      truncated: false,
    };
  });
  const manifest = {
    artifacts,
    client: { mode: "printer", repositoryId: "ui-smoke-repo", version: "smoke" },
    collectionWarnings: [],
    generatedAt: "2026-10-01T12:00:00.000Z",
    schemaVersion: 2,
  };
  const entries = Object.fromEntries(
    Object.entries(contents).map(([name, content]) => [name, strToU8(content)]),
  );
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));

  return Buffer.from(zipSync(entries));
}
