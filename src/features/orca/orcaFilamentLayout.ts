// Filament presets, arranged to mirror OrcaSlicer's Material Settings dialog:
// tabs (Filament, Cooling, Setting Overrides, Advanced, Multimaterial,
// Dependencies, Notes) each split into OrcaSlicer's sub-sections. Same
// keyword-rule approach as the machine layout — tolerant of new keys, with an
// "Other" tab catch-all.

import { arrangeTabs, classifyKey, type LayoutRule, type LayoutSpec } from "./orcaLayout";
import type { EditorField, EditorTab } from "./orcaSchema";

const RULES: readonly LayoutRule[] = [
  { tab: "Notes", section: "", test: /filament_notes|^notes$/ },

  // Advanced — the filament G-code blocks (start / end / extrusion-role-change).
  { tab: "Advanced", section: "", test: /gcode/ },

  // Dependencies.
  { tab: "Dependencies", section: "", test: /compatible_printers|compatible_prints/ },

  // Multimaterial.
  { tab: "Multimaterial", section: "Tool change parameters with multi extruder MM printers", test: /filament_multitool/ },
  {
    tab: "Multimaterial",
    section: "Tool change parameters with single extruder MM printers",
    test: /filament_(loading|unloading)_speed|filament_toolchange_delay|filament_cooling_(moves|initial_speed|final_speed)|filament_stamping|filament_ramming_parameters|filament_load_time|filament_unload_time/,
  },
  { tab: "Multimaterial", section: "Wipe tower parameters", test: /wipe_tower|minimal_purge_on_wipe_tower|filament_pre_cooling|interface_layer|tower_ironing/ },

  // Setting Overrides.
  { tab: "Setting Overrides", section: "Ironing", test: /ironing/ },
  { tab: "Setting Overrides", section: "Retraction", test: /^filament_(retract|z_hop|deretraction|wipe)/ },

  // Cooling — specific fans before the generic /fan/ rule.
  { tab: "Cooling", section: "Exhaust fan", test: /air_filtration|exhaust_fan/ },
  { tab: "Cooling", section: "Auxiliary part cooling fan", test: /additional_cooling_fan_speed/ },
  { tab: "Cooling", section: "Cooling for specific layer", test: /close_fan_the_first_x_layers|full_fan_speed_layer/ },
  { tab: "Cooling", section: "Part cooling fan", test: /fan|slow_down|overhang|reduce_fan|dont_slow_down|cooling_layer_time/ },

  // Filament tab.
  { tab: "Filament", section: "Flow ratio and Pressure Advance", test: /flow_ratio|pressure_advance/ },
  { tab: "Filament", section: "Print chamber temperature", test: /chamber_temp|activate_chamber/ },
  { tab: "Filament", section: "Bed temperature", test: /_plate_temp|^bed_type$/ },
  { tab: "Filament", section: "Print temperature", test: /^nozzle_temperature(_initial_layer)?$/ },
  { tab: "Filament", section: "Volumetric speed limitation", test: /max_volumetric_speed/ },
  {
    tab: "Filament",
    section: "Basic information",
    test: /filament_type|filament_vendor|filament_soluble|filament_is_support|filament_diameter|filament_density|filament_cost|filament_shrinkage|temperature_vitrification|idle_temperature|nozzle_temperature_range|default_filament_colour|filament_ramming_length|required_nozzle/,
  },
];

const SPEC: LayoutSpec = {
  rules: RULES,
  tabOrder: ["Filament", "Cooling", "Setting Overrides", "Advanced", "Multimaterial", "Dependencies", "Notes", "Other"],
  sectionOrder: {
    Filament: [
      "Basic information",
      "Flow ratio and Pressure Advance",
      "Print chamber temperature",
      "Print temperature",
      "Bed temperature",
      "Volumetric speed limitation",
    ],
    Cooling: ["Cooling for specific layer", "Part cooling fan", "Auxiliary part cooling fan", "Exhaust fan"],
    "Setting Overrides": ["Retraction", "Ironing"],
    Multimaterial: [
      "Wipe tower parameters",
      "Tool change parameters with single extruder MM printers",
      "Tool change parameters with multi extruder MM printers",
    ],
  },
};

/** Map a filament key to its OrcaSlicer tab + section, or the "Other" tab. */
export function classifyFilamentKey(key: string): { tab: string; section: string } {
  return classifyKey(key, RULES);
}

/** Arrange already-derived editable fields into OrcaSlicer's Material tabs. */
export function buildFilamentTabs(fields: EditorField[]): EditorTab[] {
  return arrangeTabs(fields, SPEC);
}
