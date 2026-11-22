import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { KlippyLogAnalysis } from "./types";
import { pickDefaultSession } from "./defaultSession";
import { LogDiagnosticsView } from "./LogDiagnosticsView";
import { renderWithUi } from "../../test/uiTestUtils";

function analysisFixture(overrides: {
  findings?: Array<{ session: number }>;
  sessions?: number[];
  summarySession?: number | null;
}): KlippyLogAnalysis {
  return {
    findings: (overrides.findings ?? []) as KlippyLogAnalysis["findings"],
    sessions: (overrides.sessions ?? []).map((number) => ({ number })) as KlippyLogAnalysis["sessions"],
    summary: { session: overrides.summarySession ?? null } as KlippyLogAnalysis["summary"],
  } as KlippyLogAnalysis;
}

describe("pickDefaultSession", () => {
  it("lands on the session the conclusion points at, not the newest restart", () => {
    // The crash is in session 1 while sessions 2 and 3 restarted cleanly.
    expect(pickDefaultSession(analysisFixture({
      findings: [{ session: 1 }],
      sessions: [1, 2, 3],
      summarySession: 1,
    }))).toBe("1");
  });

  it("shows all sessions combined when findings exist without one evidence session", () => {
    expect(pickDefaultSession(analysisFixture({
      findings: [{ session: 1 }, { session: 2 }],
      sessions: [1, 2, 3],
      summarySession: null,
    }))).toBe("all");
  });

  it("falls back to the newest session for a clean log with no findings", () => {
    expect(pickDefaultSession(analysisFixture({
      findings: [],
      sessions: [1, 2, 3],
      summarySession: null,
    }))).toBe("3");
  });
});

describe("LogDiagnosticsView", () => {
  it("opens a private printer upload from its diagnostics link", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    window.history.replaceState(null, "", "/log-diagnostics?upload=upload_1");
    const compressed = gzipSync(strToU8("Transition to shutdown state: ADC out of range\n"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/diagnostic-uploads") {
        return Response.json({
          uploads: [{
            contentType: "application/gzip",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            fileName: "klippy.log.gz",
            id: "upload_1",
            originalSizeBytes: 52,
            printerId: "printer_1",
            printerName: "QIDI Plus 4",
            repositoryId: "repo_1",
            sizeBytes: compressed.byteLength,
            truncated: false,
          }],
        });
      }
      if (url === "/api/diagnostic-uploads/upload_1") {
        return new Response(compressed, { headers: { "content-type": "application/gzip" } });
      }
      return Response.json({}, { status: 404 });
    }));

    renderWithUi(<LogDiagnosticsView />);

    expect(await screen.findByText("klippy.log", { selector: ".diagnostics-source-list strong" })).toBeInTheDocument();
    expect(screen.getByText("Temperature sensor reading is out of range")).toBeInTheDocument();
    const findingsTab = screen.getByRole("tab", { name: "Findings" });
    const findingsPanelId = findingsTab.getAttribute("aria-controls");
    expect(findingsPanelId).toBeTruthy();
    expect(document.getElementById(findingsPanelId!)).toHaveAttribute("role", "tabpanel");
    expect(document.getElementById(findingsPanelId!)).toHaveAttribute("aria-labelledby", findingsTab.id);
    expect(window.location.search).toBe("");
  });

  it("analyzes an uploaded log and exposes the report controls", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    const { container } = renderWithUi(<LogDiagnosticsView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const log = new File([
      "Stats 1.0: mcu: bytes_write=1 bytes_read=1 bytes_retransmit=0 bytes_invalid=0 send_seq=1 receive_seq=1 upcoming_bytes=0\n",
      "Transition to shutdown state: ADC out of range\n",
    ], "thermal-klippy.log", { type: "text/plain" });

    expect(input).not.toBeNull();
    await userEvent.upload(input!, log);

    expect(await screen.findByText("thermal-klippy.log", { selector: ".diagnostics-source-list strong" })).toBeInTheDocument();
    expect(screen.getByText("Temperature sensor reading is out of range")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Select diagnostic session" })).toHaveValue("1");
    expect(screen.getAllByText(/Session 1 · log starts mid-session/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Export HTML/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Timeline" })).toBeInTheDocument();
  });

  it("explains every large-log safeguard that discarded diagnostic detail", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    const { container } = renderWithUi(<LogDiagnosticsView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const lines = Array.from({ length: 320 }, (_, index) =>
      `Unable to obtain 'large_log_response_${index}' response`);
    lines.push(...Array.from({ length: 25 }, (_, index) => [
      `Start printer at Thu Jul 23 10:${String(index).padStart(2, "0")}:00 2026 (1 2)`,
      `Transition to shutdown state: Unknown failure ${index}`,
      "MCU 'mcu' shutdown: Timer too close",
      "Dumping send queue 40 messages",
      ...Array.from({ length: 40 }, (__, message) =>
        `Sent ${message} ${message}.0 ${message}.0 6: seq: 10, queue_step oid=1 interval=100 count=1 add=0`),
    ]).flat());
    lines.push(...Array.from({ length: 25_000 }, (_, index) =>
      `Stats ${index + 1}.0: mcu: bytes_write=${index} bytes_read=${index} bytes_retransmit=0 bytes_invalid=0 send_seq=${index} receive_seq=${index}`));

    await userEvent.upload(input!, new File([lines.join("\n")], "large-klippy.log", { type: "text/plain" }));

    expect(await screen.findByText("Large-log safeguards were applied")).toBeInTheDocument();
    expect(screen.getByText(/incident contexts omitted/)).toBeInTheDocument();
    expect(screen.getByText(/shutdown queue messages omitted/)).toBeInTheDocument();
    expect(screen.getByText(/shutdown dumps omitted/)).toBeInTheDocument();
  });

  it("turns diagnostic bundle snapshots into runtime evidence and thermal history", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    const manifest = {
      artifacts: [
        { archiveName: "logs/klippy.log", kind: "klippy-log", originalSizeBytes: 120, storedSizeBytes: 120, truncated: false },
        { archiveName: "snapshots/printer-info.json", kind: "moonraker-snapshot", originalSizeBytes: 100, storedSizeBytes: 100, truncated: false },
        { archiveName: "snapshots/printer-objects.json", kind: "moonraker-snapshot", originalSizeBytes: 200, storedSizeBytes: 200, truncated: false },
        { archiveName: "snapshots/temperature-store.json", kind: "moonraker-snapshot", originalSizeBytes: 200, storedSizeBytes: 200, truncated: false },
      ],
      client: { mode: "printer", repositoryId: "repo_1", version: "2026.07.25.2" },
      collectionWarnings: [],
      generatedAt: "2026-07-25T10:00:00Z",
      schemaVersion: 2,
    };
    const archive = zipSync({
      "logs/klippy.log": strToU8([
        "Stats 1.0: heater_bed: target=60 temp=55 pwm=1",
        "Transition to shutdown state: Lost communication with MCU 'box'",
      ].join("\n")),
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "snapshots/gcode-store.json": strToU8(JSON.stringify({
        result: { gcode_store: [{ message: "G1 X20", time: 1_721_000_000, type: "command" }] },
      })),
      "snapshots/job-history.json": strToU8(JSON.stringify({
        result: { jobs: [{ filename: "failed.gcode", print_duration: 120, start_time: 1_721_000_000, status: "klippy_shutdown", total_duration: 140 }] },
      })),
      "snapshots/printer-info.json": strToU8(JSON.stringify({
        result: { software_version: "v0.13-test", state: "shutdown", state_message: "Lost communication with MCU 'box'" },
      })),
      "snapshots/printer-objects.json": strToU8(JSON.stringify({
        result: {
          status: {
            configfile: {
              save_config_pending: true,
              save_config_pending_items: { heater_bed: { pid_kp: "new value" } },
              settings: {
                heater_bed: {
                  control: "pid",
                  max_temp: 120,
                  min_temp: 0,
                  sensor_type: "Generic 3950",
                },
                "mcu box": {
                  restart_method: "command",
                  serial: "/dev/serial/by-id/usb-box",
                },
                "verify_heater heater_bed": {
                  check_gain_time: 60,
                  heating_gain: 2,
                },
              },
              warnings: [{ message: "Deprecated heater option", type: "deprecated_option" }],
            },
            heater_bed: { power: 1, target: 60, temperature: 54.8 },
            print_stats: { filename: "failed.gcode", message: "MCU shutdown", print_duration: 120, state: "error", total_duration: 140 },
            virtual_sdcard: { progress: 0.6 },
          },
        },
      })),
      "snapshots/server-info.json": strToU8(JSON.stringify({
        result: { failed_components: [], klippy_connected: true, klippy_state: "shutdown", moonraker_version: "v0.9-test", warnings: [] },
      })),
      "snapshots/temperature-store.json": strToU8(JSON.stringify({
        result: { heater_bed: { powers: [1, 1, 1], targets: [60, 60, 60], temperatures: [56, 55.5, 54.8] } },
      })),
    });
    const { container } = renderWithUi(<LogDiagnosticsView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    await userEvent.upload(input!, new File([archive], "klippee-diagnostics.zip", { type: "application/zip" }));
    expect(await screen.findByText("Bundle captured Klipper shutdown")).toBeInTheDocument();
    expect(screen.getAllByText(/Active configuration: \[mcu box\] serial=\/dev\/serial\/by-id\/usb-box/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("tab", { name: "Snapshot" }));

    expect(screen.getByText("Capture-time evidence")).toBeInTheDocument();
    expect(screen.getByText("v0.13-test")).toBeInTheDocument();
    expect(screen.getByText("60.0% · 2m 0s printing")).toBeInTheDocument();
    expect(screen.getByText("failed.gcode", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("G1 X20")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Config" }));
    expect(screen.getByText("Active settings at the last Klipper restart")).toBeInTheDocument();
    expect(screen.getByText("Unsaved configuration changes")).toBeInTheDocument();
    expect(screen.getByText("Deprecated heater option")).toBeInTheDocument();
    expect(screen.getByText("[heater_bed]")).toBeInTheDocument();
    expect(screen.getByText("Generic 3950")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Thermals" }));
    const temperatureSession = screen.getByRole("combobox", { name: "Select temperature session" });
    await userEvent.selectOptions(temperatureSession, "bundle-temperature-history");
    expect(screen.getByRole("group", { name: /Moonraker capture.*recent 1-second history/i })).toBeInTheDocument();
  });

  it("requires explicit consent before submitting a compressed improvement sample", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ init, url });
      if (url === "/api/diagnostic-uploads") return Response.json({ uploads: [] });
      if (url === "/api/log-improvement-submissions") {
        return Response.json({
          submission: {
            expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
            fileName: "thermal-klippy.log.gz",
            id: "submission_1",
            originalFileName: "thermal-klippy.log",
            originalSizeBytes: 52,
            sha256: "abc123",
            sizeBytes: 44,
          },
        }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    }));
    const { container } = renderWithUi(<LogDiagnosticsView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const log = new File([
      "Stats 1.0: heater_bed: target=60 temp=55\n",
      "Transition to shutdown state: ADC out of range\n",
    ], "thermal-klippy.log", { type: "text/plain" });

    await userEvent.upload(input!, log);
    await screen.findByText("thermal-klippy.log", { selector: ".diagnostics-source-list strong" });
    await userEvent.click(screen.getByRole("button", { name: "More diagnostic actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Submit for improvements" }));

    expect(screen.getByText(/hardware identifiers, serial paths, hostnames, IP addresses/i)).toBeInTheDocument();
    expect(screen.getByText(/stored compressed for up to 90 days/i)).toBeInTheDocument();
    const submit = screen.getAllByRole("button", { name: "Submit for improvements" }).at(-1)!;
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByLabelText(/information about my printer and host/i));
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/reviewed these files and redacted/i));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    expect(await screen.findByRole("heading", { name: "Thank you for improving the analyzer" })).toBeInTheDocument();
    expect(screen.getByText(/Reference submission_1/)).toBeInTheDocument();
    const request = requests.find((entry) => entry.url === "/api/log-improvement-submissions");
    expect(request?.init?.headers).toMatchObject({
      "x-klippee-consent-version": "2026-07-24",
      "x-klippee-redaction-confirmed": "1",
    });
  });

  it("renders every sensor and supports hover previews and click toggles", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    const { container } = renderWithUi(<LogDiagnosticsView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const log = new File([[
      "Start printer at Thu Jul 23 10:17:18 2026 (1 2)",
      "Stats 1.0: heater_bed: target=100 temp=93.2 pwm=1.000 chamber: target=65 temp=64.8 pwm=0.200 chamber_probe: temp=63.9 extruder: target=220 temp=218.5 pwm=0.120 beacon: bytes_write=10 bytes_read=20 bytes_retransmit=0 bytes_invalid=0 send_seq=1 receive_seq=1 coil_temp=41.9 mcu_temp=42.8",
      "Stats 2.0: heater_bed: target=100 temp=93.0 pwm=1.000 chamber: target=65 temp=64.9 pwm=0.180 chamber_probe: temp=64.0 extruder: target=220 temp=219.0 pwm=0.100 beacon: bytes_write=11 bytes_read=21 bytes_retransmit=0 bytes_invalid=0 send_seq=2 receive_seq=2 coil_temp=42.0 mcu_temp=42.9",
    ].join("\n")], "multi-sensor.log", { type: "text/plain" });

    expect(input).not.toBeNull();
    await userEvent.upload(input!, log);
    await userEvent.click(await screen.findByRole("tab", { name: "Thermals" }));

    expect(screen.getByRole("group", { name: /all measured temperatures and setpoints/i })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-series-kind="measured"]')).toHaveLength(6);
    expect(container.querySelectorAll('[data-series-kind="setpoint"]')).toHaveLength(3);
    expect(container.querySelector('[data-sensor="chamber_probe"][data-series-kind="measured"]')).not.toBeNull();
    expect(container.querySelector('[data-sensor="beacon coil_temp"][data-series-kind="measured"]')).not.toBeNull();
    expect(screen.getByLabelText(/sensor legend/i)).toHaveTextContent("heater_bed");
    expect(screen.getByLabelText(/sensor legend/i)).toHaveTextContent("beacon mcu_temp");

    const bedToggle = screen.getByRole("button", { name: "heater_bed" });
    await userEvent.hover(bedToggle);
    expect(container.querySelectorAll('[data-series-kind="measured"]')).toHaveLength(1);
    expect(container.querySelector('[data-sensor="heater_bed"][data-series-kind="measured"]')).not.toBeNull();
    await userEvent.unhover(bedToggle);
    expect(container.querySelectorAll('[data-series-kind="measured"]')).toHaveLength(6);

    await userEvent.click(bedToggle);
    expect(bedToggle).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector('[data-sensor="heater_bed"]')).toBeNull();
    expect(container.querySelectorAll('[data-series-kind="measured"]')).toHaveLength(5);

    await userEvent.click(bedToggle);
    expect(bedToggle).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelectorAll('[data-series-kind="measured"]')).toHaveLength(6);

    const chamberProbeLine = container.querySelector<SVGPathElement>('[data-sensor-hit="chamber_probe"]');
    expect(chamberProbeLine).not.toBeNull();
    await userEvent.hover(chamberProbeLine!);
    expect(container.querySelectorAll('[data-series-kind="measured"]')).toHaveLength(1);
    expect(container.querySelector('[data-sensor="chamber_probe"][data-series-kind="measured"]')).not.toBeNull();
    await userEvent.unhover(chamberProbeLine!);
    expect(container.querySelectorAll('[data-series-kind="measured"]')).toHaveLength(6);

    await userEvent.click(chamberProbeLine!);
    expect(container.querySelector('[data-sensor="chamber_probe"]')).toBeNull();
  });

  it("shows correlated virtual SD outcomes and progress", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    const { container } = renderWithUi(<LogDiagnosticsView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const log = new File([[
      "File opened:failed-part.gcode Size:2000",
      "File selected",
      "Starting SD card print (position 0)",
      "Unknown command: BROKEN_MACRO",
      "Exiting SD card print (position 500)",
    ].join("\n")], "print-outcome.log", { type: "text/plain" });

    expect(input).not.toBeNull();
    await userEvent.upload(input!, log);
    await userEvent.click(await screen.findByRole("tab", { name: "Prints" }));

    expect(screen.getByText("failed-part.gcode")).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();
    expect(screen.getByText("failed", { selector: ".print-outcome" })).toBeInTheDocument();
    expect(screen.getByText("Unknown command: BROKEN_MACRO")).toBeInTheDocument();
  });

  it("explains which MCU initiated a native shutdown", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    const { container } = renderWithUi(<LogDiagnosticsView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const log = new File([[
      "Stats 1416.6: mcu: bytes_write=9832 bytes_read=274733 bytes_retransmit=9 bytes_invalid=0 send_seq=1536 receive_seq=1536 mcu_box1: bytes_write=289296 bytes_read=295799 bytes_retransmit=9 bytes_invalid=0 send_seq=21424 receive_seq=21424",
      "Transition to shutdown state: Lost communication with MCU 'mcu_box1'",
      "Dumping gcode input 1 blocks",
      "Read 1416.400000: 'G1 X95 Y324\\n'",
      "MCU 'U_1' shutdown: Command request",
      "Dumping serial stats: bytes_write=143246 bytes_read=548462 bytes_retransmit=9 bytes_invalid=0 send_seq=10476 receive_seq=10476",
      "Dumping send queue 1 messages",
      "Sent 0 1416.100000 1416.090000 6: seq: 18, get_clock",
      "Dumping receive queue 1 messages",
      "Receive: 0 1416.120000 1416.110000 8: seq: 19, clock clock=1234",
    ].join("\n")], "box-mcu-failure.log", { type: "text/plain" });

    expect(input).not.toBeNull();
    await userEvent.upload(input!, log);
    await userEvent.click(await screen.findByRole("tab", { name: "Shutdowns" }));

    expect(screen.getByText("mcu_box1 did not return a shutdown dump")).toBeInTheDocument();
    expect(screen.getByText("U_1", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Command request")).toBeInTheDocument();
    expect(screen.getByText(/1\/1 sent/)).toBeInTheDocument();
    expect(screen.getByText(/G1 X95 Y324/)).toBeInTheDocument();
  });

  it("combines multiple logs and exposes incident context and session comparison", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    const { container } = renderWithUi(<LogDiagnosticsView />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const first = new File([[
      "Start printer at Thu Jul 23 10:00:00 2026 (1 2)",
      "Stats 1.0: mcu: bytes_write=1 bytes_read=1 bytes_retransmit=0 bytes_invalid=0 send_seq=1 receive_seq=1 upcoming_bytes=0",
      "Upcoming (10): G1 X20 Y20",
      "ordinary context",
      "Transition to shutdown state: ADC out of range",
      "shutdown context",
    ].join("\n")], "klippy.log", { type: "text/plain" });
    const second = new File([[
      "Start printer at Thu Jul 23 11:00:00 2026 (3 4)",
      "Git version: 'v0.13-new'",
      "Stats 1.0: mcu: bytes_write=1 bytes_read=1 bytes_retransmit=0 bytes_invalid=0 send_seq=1 receive_seq=1 upcoming_bytes=0",
    ].join("\n")], "klippy-previous.log", { type: "text/plain" });

    expect(input).not.toBeNull();
    await userEvent.upload(input!, [first, second]);

    expect(await screen.findByText("klippy.log", { selector: ".diagnostics-source-list strong" })).toBeInTheDocument();
    expect(screen.getByText("klippy.log", { selector: ".diagnostics-source-list strong" })).toBeInTheDocument();
    expect(screen.getByText("klippy-previous.log", { selector: ".diagnostics-source-list strong" })).toBeInTheDocument();
    const sessionSelect = screen.getByRole("combobox", { name: "Select diagnostic session" }) as HTMLSelectElement;
    // The failure is in the older session (1); the newer session (2) restarted
    // cleanly. The analyzer must land on the session that carries the failure so
    // the crash isn't hidden behind the later clean restart.
    expect(sessionSelect).toHaveValue("1");
    expect(Array.from(sessionSelect.options, (option) => option.value)).toEqual(["2", "1", "all"]);
    expect(screen.getByText("Temperature sensor reading is out of range")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Incidents" }));
    // Session 1 carries the shutdown, so its incident context is visible at once.
    expect(screen.getByText("G-code and virtual SD context")).toBeInTheDocument();
    expect(screen.getAllByText("Upcoming (10): G1 X20 Y20")).toHaveLength(2);
    expect(screen.getByText("shutdown context")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Next session" }));
    expect(screen.getByText("No error incidents in this scope")).toBeInTheDocument();
    expect(screen.queryByText("shutdown context")).not.toBeInTheDocument();

    await userEvent.selectOptions(sessionSelect, "all");
    expect(sessionSelect).toHaveValue("all");

    await userEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(screen.getByRole("combobox", { name: "Select baseline session" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Select comparison session" })).toBeInTheDocument();
    expect(screen.getByText("Klipper version")).toBeInTheDocument();
  });
});
