// Machine (printer) presets, arranged to mirror OrcaSlicer's own Printer
// Settings dialog: top-level tabs (Basic information, Machine G-code,
// Multimaterial, Extruder, Motion ability, Notes) each split into the same
// sub-sections OrcaSlicer uses (Printable space, Z-Hop, Speed limitation…).
//
// Keys are classified by ordered keyword rules rather than an exhaustive
// per-key table, so a key OrcaSlicer adds later still lands in the right
// section when it matches a family (e.g. any machine_max_speed_*), and anything
// unrecognised falls into the "Other" tab — never hidden.

import { arrangeTabs, classifyKey, type LayoutRule, type LayoutSpec } from "./orcaLayout";
import type { EditorField, EditorTab } from "./orcaSchema";

// First match wins. More specific rules come first (e.g. the toolchange
// retraction split, and firmware-retraction which must not be caught by the
// generic /retract/ rule).
const RULES: readonly LayoutRule[] = [
  { tab: "Notes", section: "", test: /^notes$/ },

  // Machine G-code — every *_gcode block.
  { tab: "Machine G-code", section: "", test: /gcode/ },

  // Motion ability.
  { tab: "Motion ability", section: "Advanced", test: /emit_machine_limits/ },
  { tab: "Motion ability", section: "Resonance Compensation", test: /resonance/ },
  { tab: "Motion ability", section: "Speed limitation", test: /machine_max_speed|machine_min_(extruding|travel)_rate/ },
  { tab: "Motion ability", section: "Acceleration limitation", test: /machine_max_acceleration/ },
  { tab: "Motion ability", section: "Jerk limitation", test: /machine_max_jerk|junction_deviation/ },

  // Extruder — Retraction when switching material must precede generic retraction.
  { tab: "Extruder", section: "Retraction when switching material", test: /_toolchange/ },
  { tab: "Extruder", section: "Basic information", test: /^nozzle_diameter$|^nozzle_volume$/ },
  { tab: "Extruder", section: "Layer height limits", test: /_layer_height$/ },
  { tab: "Extruder", section: "Position", test: /^extruder_offset$/ },
  { tab: "Extruder", section: "Z-Hop", test: /z_hop|retract_lift|travel_slope/ },

  // Basic information sub-sections (before the generic retraction rule so that
  // firmware/relative-E and clearance keys are not swept into Extruder).
  { tab: "Basic information", section: "Extruder Clearance", test: /^extruder_clearance/ },
  { tab: "Basic information", section: "Adaptive bed mesh", test: /bed_mesh|adaptive_bed_mesh/ },
  { tab: "Basic information", section: "Cooling Fan", test: /^fan_|part_cooling/ },
  {
    tab: "Basic information",
    section: "Accessory",
    test: /nozzle_type|auxiliary_fan|support_chamber_temp|support_air_filtration|support_cooling_filter|cooling_filter|support_box_temp|auto_disable_filter/,
  },
  {
    tab: "Basic information",
    section: "Printable space",
    test: /printable_area|bed_exclude_area|printable_height|support_multi_bed|best_object_position|^z_offset$|preferred_orientation/,
  },
  {
    tab: "Basic information",
    section: "Advanced",
    test: /gcode_flavor|pellet_modded|use_3mf|disable_m73|disable_set_remaining|thumbnail|use_relative_e|use_firmware_retraction|time_cost|silent_mode|scan_first_layer/,
  },

  // Multimaterial.
  { tab: "Multimaterial", section: "Single extruder multi-material parameters", test: /cooling_tube|parking_pos_retraction|extra_loading_move|high_current_on_filament_swap/ },
  { tab: "Multimaterial", section: "Wipe tower", test: /wipe_tower|purge_in_prime_tower|filament_ramming/ },
  { tab: "Multimaterial", section: "Single extruder multi-material setup", test: /single_extruder_multi_material|manual_filament_change|extruders_count|bed_temperature_formula/ },
  { tab: "Multimaterial", section: "Advanced", test: /machine_(load|unload)_filament_time|machine_tool_change_time|machine_switch_extruder_time|machine_hotend_change_time/ },

  // Extruder retraction (generic) — last of the retraction-ish rules.
  { tab: "Extruder", section: "Retraction", test: /retract|wipe|deretraction|long_retraction/ },
];

const SPEC: LayoutSpec = {
  rules: RULES,
  tabOrder: ["Basic information", "Machine G-code", "Multimaterial", "Extruder", "Motion ability", "Notes", "Other"],
  sectionOrder: {
    "Basic information": ["Printable space", "Advanced", "Cooling Fan", "Extruder Clearance", "Adaptive bed mesh", "Accessory"],
    Multimaterial: [
      "Single extruder multi-material setup",
      "Wipe tower",
      "Single extruder multi-material parameters",
      "Advanced",
    ],
    Extruder: ["Basic information", "Layer height limits", "Position", "Retraction", "Z-Hop", "Retraction when switching material"],
    "Motion ability": ["Advanced", "Resonance Compensation", "Speed limitation", "Acceleration limitation", "Jerk limitation"],
  },
};

/** Map a machine key to its OrcaSlicer tab + section, or the "Other" tab. */
export function classifyMachineKey(key: string): { tab: string; section: string } {
  return classifyKey(key, RULES);
}

/** Arrange already-derived editable fields into OrcaSlicer's tab/section tree. */
export function buildMachineTabs(fields: EditorField[]): EditorTab[] {
  return arrangeTabs(fields, SPEC);
}
