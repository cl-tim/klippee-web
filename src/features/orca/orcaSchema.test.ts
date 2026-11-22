import { describe, expect, it } from "vitest";
import { buildEditorModel, fieldControl, humanizeKey } from "./orcaSchema";

describe("humanizeKey", () => {
  it("title-cases snake_case and fixes common acronyms", () => {
    expect(humanizeKey("nozzle_temperature_initial_layer")).toBe("Nozzle temperature initial layer");
    expect(humanizeKey("machine_start_gcode")).toBe("Machine start G-code");
    expect(humanizeKey("filament_flow_ratio")).toBe("Filament flow ratio");
  });

  it("uppercases single-letter words (axes)", () => {
    expect(humanizeKey("machine_max_speed_x")).toBe("Machine max speed X");
  });
});

describe("fieldControl", () => {
  it("treats single-element arrays and short strings as scalar", () => {
    expect(fieldControl(["210"])).toBe("scalar");
    expect(fieldControl("0.4")).toBe("scalar");
    expect(fieldControl([])).toBe("scalar");
  });

  it("treats multi-element arrays as list", () => {
    expect(fieldControl(["600", "600"])).toBe("list");
  });

  it("treats newline or long text as multiline", () => {
    expect(fieldControl("G28\nG1 Z5")).toBe("multiline");
    expect(fieldControl("x".repeat(90))).toBe("multiline");
  });

  it("always treats gcode keys as multiline, even when short", () => {
    expect(fieldControl("PRINT_START", "machine_start_gcode")).toBe("multiline");
    expect(fieldControl("", "filament_end_gcode")).toBe("multiline");
  });
});

describe("buildEditorModel", () => {
  const processJson = {
    type: "process",
    name: "0.20 Standard",
    inherits: "0.20mm Standard @Qidi",
    print_settings_id: "0.20 Standard",
    layer_height: "0.2",
    sparse_infill_density: "15%",
    // A key the app has never heard of — must still appear.
    totally_new_orca_key: ["keep-me"],
  };

  const allFieldKeys = (model: ReturnType<typeof buildEditorModel>) =>
    model.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.fields.map((field) => field.key)));

  it("separates identity keys from editable settings and omits name", () => {
    const model = buildEditorModel(processJson, "process");
    const identityKeys = model.identity.map((field) => field.key);
    expect(identityKeys).toContain("type");
    expect(identityKeys).toContain("inherits");
    expect(identityKeys).toContain("print_settings_id");
    const keys = allFieldKeys(model);
    expect(keys).not.toContain("name");
    expect(keys).not.toContain("type");
    expect(keys).toContain("layer_height");
  });

  it("surfaces unknown keys in an 'Other' tab (schema tolerance)", () => {
    const model = buildEditorModel(processJson, "process");
    const other = model.tabs.find((tab) => tab.title === "Other");
    const otherKeys = other?.sections.flatMap((section) => section.fields.map((field) => field.key)) ?? [];
    expect(otherKeys).toContain("totally_new_orca_key");
  });

  it("produces a tabbed model for every preset type", () => {
    const machine = buildEditorModel(
      { type: "machine", name: "example1", printer_settings_id: "example1", machine_max_speed_x: ["600"] },
      "machine",
    );
    const filament = buildEditorModel({ type: "filament", name: "PLA", filament_type: ["PLA"] }, "filament");
    const process = buildEditorModel(processJson, "process");
    expect(machine.tabs.length).toBeGreaterThan(0);
    expect(filament.tabs.length).toBeGreaterThan(0);
    expect(process.tabs.length).toBeGreaterThan(0);
  });
});
