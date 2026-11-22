import { describe, expect, it } from "vitest";
import {
  buildDiagnosticConfigFindings,
  correlateFindingsWithDiagnosticConfig,
  parseDiagnosticConfigEvidence,
} from "./diagnosticConfigEvidence";
import type { DiagnosticFinding } from "./types";
import { analyzeKlippyLog } from "./analyzer";

describe("diagnostic configuration evidence", () => {
  it("links an eddy probe travel failure to probe geometry, Z limits, and leveling points", () => {
    const config = parseDiagnosticConfigEvidence({ settings: {
      "probe_eddy_current btt_eddy": { sensor_type: "ldc1612", x_offset: 0, y_offset: 21.42, descend_z: 1.5 },
      stepper_z: { endstop_pin: "probe:z_virtual_endstop", position_min: 0, position_max: 280 },
      quad_gantry_level: { points: [[30, 15], [30, 245], [270, 245], [270, 15]], horizontal_move_z: 10 },
    } });
    const analysis = analyzeKlippyLog("No trigger on probe after full movement\n");
    const findings = correlateFindingsWithDiagnosticConfig(analysis.findings, config!);
    const probe = findings.find((item) => item.id === "probe-no-trigger");
    expect(probe?.detail).toContain("[probe_eddy_current btt_eddy]");
    expect(probe?.detail).toContain("y_offset=21.42");
    expect(probe?.detail).toContain("position_min=0");
    expect(probe?.detail).toContain("[quad_gantry_level]");
    expect(probe?.evidence.at(-1)?.source).toBe("snapshots/printer-objects.json#configfile");
  });

  it("retains resolved diagnostic sections, warnings, and pending SAVE_CONFIG items", () => {
    const config = parseDiagnosticConfigEvidence({
      save_config_pending: true,
      save_config_pending_items: {
        heater_bed: {
          pid_kd: "new value",
          pid_ki: "new value",
          pid_kp: "new value",
        },
      },
      settings: {
        "gcode_macro START_PRINT": { gcode: "G28" },
        heater_bed: {
          control: "pid",
          heater_pin: "box:PB4",
          max_power: 1,
          max_temp: 120,
          min_temp: 0,
          sensor_pin: "box:PA3",
          sensor_type: "Generic 3950",
        },
        "mcu box": {
          restart_method: "command",
          serial: "/dev/serial/by-id/usb-box",
        },
        printer: {
          kinematics: "corexy",
          max_accel: 10_000,
          max_velocity: 500,
        },
        stepper_x: {
          dir_pin: "!PC1",
          rotation_distance: 40,
          step_pin: "PC0",
        },
        "verify_heater heater_bed": {
          check_gain_time: 60,
          heating_gain: 2,
          max_error: 120,
        },
      },
      warnings: [{
        message: "Option 'old_setting' is deprecated",
        type: "deprecated_option",
      }],
    });

    expect(config).toMatchObject({
      pendingSave: true,
      pendingSaveItems: [
        "heater_bed.pid_kd",
        "heater_bed.pid_ki",
        "heater_bed.pid_kp",
      ],
      retainedSectionCount: 5,
      sectionCount: 6,
      warnings: [{
        message: "Option 'old_setting' is deprecated",
        type: "deprecated_option",
      }],
    });
    expect(config?.sections.map((section) => section.name)).toEqual([
      "heater_bed",
      "mcu box",
      "printer",
      "stepper_x",
      "verify_heater heater_bed",
    ]);

    const configFindings = buildDiagnosticConfigFindings(config!, 2);
    expect(configFindings.map((finding) => finding.id)).toEqual([
      "bundle-config-save-pending",
      "bundle-klipper-config-warnings",
    ]);

    const findings = correlateFindingsWithDiagnosticConfig([
      finding("communication", "Lost communication with MCU 'box'"),
      finding("heating", "heater_bed could not hold its requested temperature"),
      finding("motion", "Move out of range"),
    ], config!);
    expect(findings[0].detail).toContain("[mcu box] serial=/dev/serial/by-id/usb-box");
    expect(findings[1].detail).toContain("[heater_bed] sensor_type=Generic 3950");
    expect(findings[1].detail).toContain("[verify_heater heater_bed]");
    expect(findings[2].detail).toContain("[printer] kinematics=corexy");
    expect(findings[0].evidence.at(-1)?.source).toBe("snapshots/printer-objects.json#configfile");
  });

  it("bounds retained sections and options", () => {
    const settings = Object.fromEntries(Array.from({ length: 200 }, (_, sectionIndex) => [
      `temperature_sensor sensor_${sectionIndex}`,
      Object.fromEntries(Array.from({ length: 100 }, (_, optionIndex) => [`option_${optionIndex}`, optionIndex])),
    ]));
    const config = parseDiagnosticConfigEvidence({ settings });

    expect(config?.sectionCount).toBe(200);
    expect(config?.retainedSectionCount).toBe(160);
    expect(Object.keys(config!.sections[0].options)).toHaveLength(80);
  });
});

function finding(family: DiagnosticFinding["family"], message: string): DiagnosticFinding {
  return {
    checks: ["Original check"],
    confidence: "high",
    detail: message,
    evidence: [{
      line: 10,
      message,
      session: 1,
      source: "klippy.log",
      time: 100,
    }],
    family,
    id: `fixture-${family}`,
    session: 1,
    severity: "error",
    title: message,
  };
}
