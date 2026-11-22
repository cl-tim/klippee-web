// Process (print) presets, arranged to mirror OrcaSlicer's Process Settings
// dialog: Quality, Strength, Speed, Support, Multimaterial, Others (plus
// Dependencies / Notes). Same keyword-rule + "Other" fallback approach as the
// machine and filament layouts.
//
// NOTE: unlike the machine and filament layouts (built from OrcaSlicer
// screenshots), the process sub-sections here are reconstructed from the known
// Process Settings structure. Tab assignment is reliable; a few sub-sections
// may need nudging against the live UI. Everything is still shown — nothing is
// hidden — so refinements are cosmetic.

import { arrangeTabs, classifyKey, type LayoutRule, type LayoutSpec } from "./orcaLayout";
import type { EditorField, EditorTab } from "./orcaSchema";

const RULES: readonly LayoutRule[] = [
  { tab: "Notes", section: "", test: /^notes$/ },
  { tab: "Dependencies", section: "", test: /compatible_printers|compatible_prints|^print_extruder/ },

  // Quality — specific families first.
  { tab: "Quality", section: "Ironing", test: /^ironing_/ },
  { tab: "Quality", section: "Seam", test: /seam_/ },
  { tab: "Quality", section: "Precision", test: /^resolution$|arc_fitting|xy_hole_compensation|xy_contour_compensation|elefant_foot|smooth_coefficient|slice_closing/ },
  { tab: "Quality", section: "Line width", test: /line_width/ },

  // Support — before the generic speed rule so support_*_speed stay here.
  { tab: "Support", section: "Raft", test: /raft/ },
  { tab: "Support", section: "Tree support", test: /tree_support/ },
  { tab: "Support", section: "Support filament", test: /support_(interface_)?filament/ },
  { tab: "Support", section: "Support", test: /support/ },

  // Speed.
  { tab: "Speed", section: "Acceleration", test: /acceleration/ },
  { tab: "Speed", section: "Jerk (XY)", test: /jerk/ },
  { tab: "Speed", section: "Travel speed", test: /travel_speed|max_travel_detour/ },
  { tab: "Speed", section: "Overhang speed", test: /overhang_._4_speed|slowdown_for_curled/ },
  { tab: "Speed", section: "Other layers speed", test: /_speed$|gap_infill_speed|small_perimeter_threshold/ },

  // Strength — shells and walls before the generic infill rule.
  { tab: "Strength", section: "Top and bottom shells", test: /top_shell|bottom_shell|_surface_pattern|color_penetration|interface_shells/ },
  { tab: "Strength", section: "Walls", test: /wall_loops|detect_thin_wall/ },
  { tab: "Strength", section: "Infill", test: /infill/ },

  // Quality — walls/surfaces, bridging, layer height (after Strength walls so
  // wall_loops lands in Strength).
  { tab: "Quality", section: "Walls and surfaces", test: /wall_generator|detect_overhang_wall|overhang_reverse|wall_infill_order|reduce_crossing_wall|wall_distribution|only_one_wall/ },
  { tab: "Quality", section: "Bridging", test: /bridge/ },
  { tab: "Quality", section: "Layer height", test: /layer_height|initial_layer_print_height|adaptive_layer/ },

  // Multimaterial.
  { tab: "Multimaterial", section: "", test: /prime_tower|wipe_tower|standby_temperature_delta|ooze|flush|interlocking/ },

  // Others.
  { tab: "Others", section: "Skirt and brim", test: /skirt|brim|draft_shield/ },
  { tab: "Others", section: "Special mode", test: /spiral_mode|print_sequence/ },
  { tab: "Others", section: "Output", test: /filename_format|reduce_infill_retraction|reduce_crossing/ },
];

const SPEC: LayoutSpec = {
  rules: RULES,
  tabOrder: ["Quality", "Strength", "Speed", "Support", "Multimaterial", "Others", "Dependencies", "Notes", "Other"],
  sectionOrder: {
    Quality: ["Layer height", "Line width", "Seam", "Precision", "Ironing", "Walls and surfaces", "Bridging"],
    Strength: ["Walls", "Top and bottom shells", "Infill"],
    Speed: ["Other layers speed", "Overhang speed", "Travel speed", "Acceleration", "Jerk (XY)"],
    Support: ["Support", "Raft", "Support filament", "Tree support"],
    Others: ["Skirt and brim", "Special mode", "Output"],
  },
};

/** Map a process key to its OrcaSlicer tab + section, or the "Other" tab. */
export function classifyProcessKey(key: string): { tab: string; section: string } {
  return classifyKey(key, RULES);
}

/** Arrange already-derived editable fields into OrcaSlicer's Process tabs. */
export function buildProcessTabs(fields: EditorField[]): EditorTab[] {
  return arrangeTabs(fields, SPEC);
}
