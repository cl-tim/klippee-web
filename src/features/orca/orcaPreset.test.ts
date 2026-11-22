import { describe, expect, it } from "vitest";
import {
  detectPresetType,
  getPresetField,
  parseOrcaPreset,
  presetDisplayName,
  serializeOrcaPreset,
  setPresetField,
} from "./orcaPreset";

const filamentText = JSON.stringify({
  type: "filament",
  name: "Generic PLA @Voron",
  from: "User",
  inherits: "fdm_filament_pla",
  setting_id: "GFL_XYZ",
  nozzle_temperature: ["210"],
  nozzle_temperature_initial_layer: ["215"],
  filament_start_gcode: "; start\nM117 hi",
  compatible_printers: ["Voron 2.4 0.4", "Voron 2.4 0.6"],
  // A key the curated form never surfaces — must always survive round-trips.
  filament_some_future_key: ["keep-me"],
});

// Real OrcaSlicer user presets omit `type` entirely and are identified by a
// settings-id key. These fixtures mirror actual exported files (v2.3–2.4):
// sparse overrides that inherit the rest, mixing array and plain-string values.
const realMachineText = JSON.stringify({
  from: "User",
  inherits: "Qidi X-Plus 4 0.4 nozzle",
  machine_start_gcode: "PRINT_START BED=[bed_temperature_initial_layer_single]",
  name: "example1",
  nozzle_type: ["tungsten_carbide"],
  printer_settings_id: "example1",
  version: "2.3.2.60",
});
const realFilamentText = JSON.stringify({
  compatible_printers: ["Qidi X-Plus 4 0.4 nozzle"],
  filament_flow_ratio: ["0.9776"],
  filament_settings_id: ["Elegoo PETG Pro Lower Temp"],
  from: "User",
  inherits: "Elegoo PETG Pro @System",
  name: "Elegoo PETG Pro Lower Temp",
});
const realProcessText = JSON.stringify({
  brim_type: "no_brim",
  from: "User",
  inherits: "0.20mm Standard @Qidi XPlus4",
  name: "0.20mm Standard Rectilinear",
  print_settings_id: "0.20mm Standard Rectilinear",
  wall_loops: "3",
});

describe("detectPresetType — real typeless user presets", () => {
  it("infers the type from the settings-id when `type` is absent", () => {
    expect(parseOrcaPreset(realMachineText)?.type).toBe("machine");
    expect(parseOrcaPreset(realFilamentText)?.type).toBe("filament");
    expect(parseOrcaPreset(realProcessText)?.type).toBe("process");
  });

  it("does not confuse printer_settings_id with print_settings_id", () => {
    expect(detectPresetType({ printer_settings_id: "x" })).toBe("machine");
    expect(detectPresetType({ print_settings_id: "x" })).toBe("process");
  });

  it("still honours an explicit type field when present", () => {
    expect(detectPresetType({ type: "printer" })).toBe("machine");
    expect(detectPresetType({ type: "filament", filament_settings_id: ["x"] })).toBe("filament");
  });

  it("reads plain-string values (process/machine) as well as arrays", () => {
    const process = parseOrcaPreset(realProcessText)!;
    expect(getPresetField(process.json, "wall_loops", "scalar")).toBe("3");
    const machine = parseOrcaPreset(realMachineText)!;
    expect(getPresetField(machine.json, "machine_start_gcode", "multiline")).toContain("PRINT_START");
  });

  it("round-trips a sparse typeless preset, preserving its plain-string shape", () => {
    const process = parseOrcaPreset(realProcessText)!;
    const edited = setPresetField(process.json, "wall_loops", "4", "scalar");
    // wall_loops arrived as a plain string, so it stays a plain string.
    expect(edited.wall_loops).toBe("4");
    const reparsed = parseOrcaPreset(serializeOrcaPreset(edited))!;
    expect(reparsed.type).toBe("process");
    expect(reparsed.inherits).toBe("0.20mm Standard @Qidi XPlus4");
    expect(reparsed.json.print_settings_id).toBe("0.20mm Standard Rectilinear");
  });
});

describe("parseOrcaPreset / detectPresetType", () => {
  it("parses a filament preset with metadata", () => {
    const preset = parseOrcaPreset(filamentText);
    expect(preset).not.toBeNull();
    expect(preset?.type).toBe("filament");
    expect(preset?.name).toBe("Generic PLA @Voron");
    expect(preset?.inherits).toBe("fdm_filament_pla");
  });

  it("treats 'printer' as the canonical 'machine' type", () => {
    expect(detectPresetType({ type: "printer" })).toBe("machine");
    expect(detectPresetType({ type: "machine" })).toBe("machine");
    expect(detectPresetType({ type: "process" })).toBe("process");
  });

  it("returns null for non-presets", () => {
    expect(parseOrcaPreset("not json")).toBeNull();
    expect(parseOrcaPreset("[1,2,3]")).toBeNull();
    expect(parseOrcaPreset("42")).toBeNull();
    expect(parseOrcaPreset(JSON.stringify({ name: "x" }))).toBeNull();
    expect(parseOrcaPreset(JSON.stringify({ type: "something-else" }))).toBeNull();
  });

  it("falls back to a placeholder display name", () => {
    expect(presetDisplayName({ type: "filament", name: "  ", inherits: null, json: {} })).toBe("Untitled preset");
  });
});

describe("getPresetField", () => {
  const json = parseOrcaPreset(filamentText)!.json;

  it("unwraps single-element arrays for scalar fields", () => {
    expect(getPresetField(json, "nozzle_temperature", "scalar")).toBe("210");
  });

  it("joins arrays one-per-line for list fields and returns '' for missing keys", () => {
    expect(getPresetField(json, "compatible_printers", "list")).toBe("Voron 2.4 0.4\nVoron 2.4 0.6");
    expect(getPresetField(json, "does_not_exist", "scalar")).toBe("");
  });

  it("returns plain strings verbatim for multiline fields", () => {
    expect(getPresetField(json, "filament_start_gcode", "multiline")).toBe("; start\nM117 hi");
  });
});

describe("setPresetField — shape preservation", () => {
  const json = parseOrcaPreset(filamentText)!.json;

  it("keeps the single-element array shape for scalar edits", () => {
    const next = setPresetField(json, "nozzle_temperature", "220", "scalar");
    expect(next.nozzle_temperature).toEqual(["220"]);
  });

  it("adds a brand-new scalar key as a single-element array", () => {
    const next = setPresetField(json, "brand_new_scalar", "5", "scalar");
    expect(next.brand_new_scalar).toEqual(["5"]);
  });

  it("splits list edits on commas and newlines, trimming blanks", () => {
    const next = setPresetField(json, "compatible_printers", "A, B\n C ,", "list");
    expect(next.compatible_printers).toEqual(["A", "B", "C"]);
  });

  it("stores gcode as a plain string", () => {
    const next = setPresetField(json, "filament_start_gcode", "G28\nG1 Z5", "multiline");
    expect(next.filament_start_gcode).toBe("G28\nG1 Z5");
  });

  it("clears an existing key without dropping it, and ignores clears of absent keys", () => {
    const cleared = setPresetField(json, "nozzle_temperature", "", "scalar");
    expect(cleared.nozzle_temperature).toEqual([""]);
    const noop = setPresetField(json, "never_here", "", "scalar");
    expect("never_here" in noop).toBe(false);
  });

  it("does not mutate the input object", () => {
    const before = JSON.stringify(json);
    setPresetField(json, "nozzle_temperature", "999", "scalar");
    expect(JSON.stringify(json)).toBe(before);
  });
});

describe("round-trip fidelity", () => {
  it("preserves unknown keys, inheritance, and untouched values through an edit", () => {
    const original = parseOrcaPreset(filamentText)!;
    const edited = setPresetField(original.json, "nozzle_temperature", "205", "scalar");
    const reparsed = parseOrcaPreset(serializeOrcaPreset(edited))!;

    expect(reparsed.type).toBe("filament");
    expect(reparsed.inherits).toBe("fdm_filament_pla");
    // The one edited key changed…
    expect(reparsed.json.nozzle_temperature).toEqual(["205"]);
    // …and everything the form never touched survived verbatim.
    expect(reparsed.json.setting_id).toBe("GFL_XYZ");
    expect(reparsed.json.filament_some_future_key).toEqual(["keep-me"]);
    expect(reparsed.json.nozzle_temperature_initial_layer).toEqual(["215"]);
  });
});
