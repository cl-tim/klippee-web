import { describe, expect, it } from "vitest";
import { buildMachineTabs, classifyMachineKey } from "./orcaMachineLayout";
import type { EditorField } from "./orcaSchema";

const field = (key: string): EditorField => ({ key, label: key, control: "scalar" });

describe("classifyMachineKey", () => {
  it("maps keys to OrcaSlicer's tabs and sub-sections", () => {
    expect(classifyMachineKey("machine_start_gcode")).toEqual({ tab: "Machine G-code", section: "" });
    expect(classifyMachineKey("machine_max_speed_x")).toEqual({ tab: "Motion ability", section: "Speed limitation" });
    expect(classifyMachineKey("machine_max_jerk_x")).toEqual({ tab: "Motion ability", section: "Jerk limitation" });
    expect(classifyMachineKey("extruder_clearance_radius")).toEqual({ tab: "Basic information", section: "Extruder Clearance" });
    expect(classifyMachineKey("bed_exclude_area")).toEqual({ tab: "Basic information", section: "Printable space" });
    expect(classifyMachineKey("nozzle_type")).toEqual({ tab: "Basic information", section: "Accessory" });
    expect(classifyMachineKey("nozzle_diameter")).toEqual({ tab: "Extruder", section: "Basic information" });
    expect(classifyMachineKey("retraction_length")).toEqual({ tab: "Extruder", section: "Retraction" });
    expect(classifyMachineKey("z_hop")).toEqual({ tab: "Extruder", section: "Z-Hop" });
    expect(classifyMachineKey("single_extruder_multi_material")).toEqual({
      tab: "Multimaterial",
      section: "Single extruder multi-material setup",
    });
    expect(classifyMachineKey("notes")).toEqual({ tab: "Notes", section: "" });
  });

  it("splits toolchange retraction from ordinary retraction", () => {
    expect(classifyMachineKey("retract_length_toolchange")).toEqual({ tab: "Extruder", section: "Retraction when switching material" });
    expect(classifyMachineKey("retraction_length")).toEqual({ tab: "Extruder", section: "Retraction" });
  });

  it("keeps acceleration-for-retracting under Acceleration, not Retraction", () => {
    // The naive heuristic mis-filed this under Retraction; the layout must not.
    expect(classifyMachineKey("machine_max_acceleration_retracting")).toEqual({
      tab: "Motion ability",
      section: "Acceleration limitation",
    });
  });

  it("keeps firmware-retraction under Basic/Advanced, not Extruder/Retraction", () => {
    expect(classifyMachineKey("use_firmware_retraction")).toEqual({ tab: "Basic information", section: "Advanced" });
  });

  it("drops unrecognised keys into the Other tab", () => {
    expect(classifyMachineKey("some_future_machine_key")).toEqual({ tab: "Other", section: "" });
  });
});

describe("buildMachineTabs", () => {
  it("orders tabs like OrcaSlicer and appends Other last", () => {
    const tabs = buildMachineTabs([
      field("some_future_machine_key"),
      field("machine_max_speed_x"),
      field("printable_height"),
      field("machine_start_gcode"),
    ]);
    expect(tabs.map((tab) => tab.title)).toEqual(["Basic information", "Machine G-code", "Motion ability", "Other"]);
  });

  it("orders sub-sections within a tab and never hides a field", () => {
    const tabs = buildMachineTabs([
      field("machine_max_jerk_x"),
      field("machine_max_speed_x"),
      field("machine_max_acceleration_x"),
    ]);
    const motion = tabs.find((tab) => tab.title === "Motion ability");
    expect(motion?.sections.map((section) => section.title)).toEqual([
      "Speed limitation",
      "Acceleration limitation",
      "Jerk limitation",
    ]);
  });
});
