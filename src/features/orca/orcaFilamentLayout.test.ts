import { describe, expect, it } from "vitest";
import { buildFilamentTabs, classifyFilamentKey } from "./orcaFilamentLayout";
import type { EditorField } from "./orcaSchema";

const field = (key: string): EditorField => ({ key, label: key, control: "scalar" });

describe("classifyFilamentKey", () => {
  it("maps keys to OrcaSlicer's Material Settings tabs and sections", () => {
    expect(classifyFilamentKey("filament_type")).toEqual({ tab: "Filament", section: "Basic information" });
    expect(classifyFilamentKey("filament_flow_ratio")).toEqual({ tab: "Filament", section: "Flow ratio and Pressure Advance" });
    expect(classifyFilamentKey("pressure_advance")).toEqual({ tab: "Filament", section: "Flow ratio and Pressure Advance" });
    expect(classifyFilamentKey("nozzle_temperature")).toEqual({ tab: "Filament", section: "Print temperature" });
    expect(classifyFilamentKey("hot_plate_temp")).toEqual({ tab: "Filament", section: "Bed temperature" });
    expect(classifyFilamentKey("chamber_temperature")).toEqual({ tab: "Filament", section: "Print chamber temperature" });
    expect(classifyFilamentKey("filament_max_volumetric_speed")).toEqual({ tab: "Filament", section: "Volumetric speed limitation" });
  });

  it("distinguishes the recommended nozzle range from the print temperature", () => {
    // Range fields belong to Basic information; the actual print temps to Print temperature.
    expect(classifyFilamentKey("nozzle_temperature_range_high")).toEqual({ tab: "Filament", section: "Basic information" });
    expect(classifyFilamentKey("nozzle_temperature_initial_layer")).toEqual({ tab: "Filament", section: "Print temperature" });
  });

  it("routes the cooling fans to their specific sections before the generic fan rule", () => {
    expect(classifyFilamentKey("additional_cooling_fan_speed")).toEqual({ tab: "Cooling", section: "Auxiliary part cooling fan" });
    expect(classifyFilamentKey("activate_air_filtration")).toEqual({ tab: "Cooling", section: "Exhaust fan" });
    expect(classifyFilamentKey("close_fan_the_first_x_layers")).toEqual({ tab: "Cooling", section: "Cooling for specific layer" });
    expect(classifyFilamentKey("fan_max_speed")).toEqual({ tab: "Cooling", section: "Part cooling fan" });
  });

  it("maps overrides, gcode, dependencies, and multimaterial", () => {
    expect(classifyFilamentKey("filament_retraction_length")).toEqual({ tab: "Setting Overrides", section: "Retraction" });
    expect(classifyFilamentKey("filament_start_gcode")).toEqual({ tab: "Advanced", section: "" });
    expect(classifyFilamentKey("compatible_printers")).toEqual({ tab: "Dependencies", section: "" });
    expect(classifyFilamentKey("filament_loading_speed")).toEqual({
      tab: "Multimaterial",
      section: "Tool change parameters with single extruder MM printers",
    });
    expect(classifyFilamentKey("filament_multitool_ramming")).toEqual({
      tab: "Multimaterial",
      section: "Tool change parameters with multi extruder MM printers",
    });
  });

  it("drops unrecognised keys into the Other tab", () => {
    expect(classifyFilamentKey("some_future_filament_key")).toEqual({ tab: "Other", section: "" });
  });
});

describe("buildFilamentTabs", () => {
  it("orders tabs like OrcaSlicer and keeps every field", () => {
    const tabs = buildFilamentTabs([
      field("some_future_filament_key"),
      field("fan_max_speed"),
      field("filament_type"),
      field("filament_start_gcode"),
    ]);
    expect(tabs.map((tab) => tab.title)).toEqual(["Filament", "Cooling", "Advanced", "Other"]);
    const allKeys = tabs.flatMap((tab) => tab.sections.flatMap((section) => section.fields.map((f) => f.key)));
    expect(allKeys).toContain("some_future_filament_key");
  });
});
