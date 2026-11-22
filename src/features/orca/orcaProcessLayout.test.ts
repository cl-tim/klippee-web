import { describe, expect, it } from "vitest";
import { buildProcessTabs, classifyProcessKey } from "./orcaProcessLayout";
import type { EditorField } from "./orcaSchema";

const field = (key: string): EditorField => ({ key, label: key, control: "scalar" });

describe("classifyProcessKey", () => {
  it("maps keys to OrcaSlicer's Process tabs", () => {
    expect(classifyProcessKey("layer_height").tab).toBe("Quality");
    expect(classifyProcessKey("sparse_infill_density").tab).toBe("Strength");
    expect(classifyProcessKey("outer_wall_speed").tab).toBe("Speed");
    expect(classifyProcessKey("enable_support").tab).toBe("Support");
    expect(classifyProcessKey("enable_prime_tower").tab).toBe("Multimaterial");
    expect(classifyProcessKey("brim_width").tab).toBe("Others");
    expect(classifyProcessKey("compatible_printers").tab).toBe("Dependencies");
  });

  it("routes speed/accel/jerk and line-width families correctly", () => {
    expect(classifyProcessKey("outer_wall_acceleration")).toEqual({ tab: "Speed", section: "Acceleration" });
    expect(classifyProcessKey("outer_wall_jerk")).toEqual({ tab: "Speed", section: "Jerk (XY)" });
    expect(classifyProcessKey("travel_speed")).toEqual({ tab: "Speed", section: "Travel speed" });
    // Line width is a Quality concern even for wall/infill/support keys.
    expect(classifyProcessKey("outer_wall_line_width")).toEqual({ tab: "Quality", section: "Line width" });
    expect(classifyProcessKey("support_line_width")).toEqual({ tab: "Quality", section: "Line width" });
  });

  it("keeps support speeds in the Support tab, not Speed", () => {
    expect(classifyProcessKey("support_speed").tab).toBe("Support");
    expect(classifyProcessKey("support_interface_speed").tab).toBe("Support");
  });

  it("splits walls (Strength) from wall generation (Quality)", () => {
    expect(classifyProcessKey("wall_loops")).toEqual({ tab: "Strength", section: "Walls" });
    expect(classifyProcessKey("wall_generator")).toEqual({ tab: "Quality", section: "Walls and surfaces" });
  });

  it("drops unrecognised keys into the Other tab", () => {
    expect(classifyProcessKey("some_future_process_key")).toEqual({ tab: "Other", section: "" });
  });
});

describe("buildProcessTabs", () => {
  it("orders tabs like OrcaSlicer and keeps every field", () => {
    const tabs = buildProcessTabs([
      field("some_future_process_key"),
      field("outer_wall_speed"),
      field("layer_height"),
      field("enable_support"),
    ]);
    expect(tabs.map((tab) => tab.title)).toEqual(["Quality", "Speed", "Support", "Other"]);
    const allKeys = tabs.flatMap((tab) => tab.sections.flatMap((section) => section.fields.map((f) => f.key)));
    expect(allKeys).toContain("some_future_process_key");
  });
});
