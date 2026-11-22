// Dynamic editor model derived from a preset's actual keys.
//
// Instead of a hardcoded list of known OrcaSlicer keys, the editor is built from
// whatever the preset actually contains, then arranged to mirror OrcaSlicer's
// own tabbed dialogs (see the per-type layout modules). This tolerates
// OrcaSlicer schema changes for free: a new key shows up with a humanised label
// and an input inferred from its value, routed to the right tab/section when it
// matches a family, or dropped into an "Other" tab. Nothing is ever hidden.

import type { OrcaFieldShape, OrcaPresetJson, OrcaPresetType } from "./orcaPreset";
import { buildMachineTabs } from "./orcaMachineLayout";
import { buildFilamentTabs } from "./orcaFilamentLayout";
import { buildProcessTabs } from "./orcaProcessLayout";

export type EditorField = {
  /** The underlying OrcaSlicer key. */
  key: string;
  /** Human-readable label derived from the key. */
  label: string;
  /** Which input the value maps onto (aligned with getPresetField shapes). */
  control: OrcaFieldShape;
};

// A tab (OrcaSlicer dialog tab) holds ordered sub-sections of fields.
export type EditorSection = { title: string; fields: EditorField[] };
export type EditorTab = { title: string; sections: EditorSection[] };

export type EditorModel = {
  /** Read-only identity keys (type, inherits, ids, version…). */
  identity: EditorField[];
  /** Editable settings, arranged into OrcaSlicer's tabs and sub-sections. */
  tabs: EditorTab[];
};

// Identity keys are shown read-only and kept out of the editable groups. `name`
// is handled separately by the preset-name field, so it is excluded entirely.
const IDENTITY_KEYS = new Set([
  "type",
  "from",
  "inherits",
  "instantiation",
  "renamed_from",
  "setting_id",
  "filament_id",
  "printer_settings_id",
  "print_settings_id",
  "filament_settings_id",
  "version",
]);

const IDENTITY_ORDER = [
  "type",
  "inherits",
  "from",
  "instantiation",
  "printer_settings_id",
  "print_settings_id",
  "filament_settings_id",
  "setting_id",
  "filament_id",
  "version",
];

// A few whole-word replacements so humanised labels read naturally. Anything not
// listed just gets title-cased — no per-key maintenance required.
const WORD_REPLACEMENTS: Record<string, string> = {
  gcode: "G-code",
  pa: "PA",
  id: "ID",
  pid: "PID",
  abl: "ABL",
  api: "API",
  ip: "IP",
  url: "URL",
};

/** Turn a snake_case key into a readable label ("nozzle_temperature" → "Nozzle temperature"). */
export function humanizeKey(key: string): string {
  const words = key
    .split("_")
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (WORD_REPLACEMENTS[lower]) return WORD_REPLACEMENTS[lower];
      if (word.length === 1) return word.toUpperCase();
      return word;
    });
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Infer which control a value maps onto:
 * - `list`      → an array with more than one element (edited one-per-line).
 * - `multiline` → G-code keys, or long / newline-containing text.
 * - `scalar`    → everything else (a single input).
 *
 * The optional `key` lets G-code fields always render as a textarea even when
 * the current value is short.
 */
export function fieldControl(value: unknown, key?: string): OrcaFieldShape {
  if (key && /gcode/i.test(key)) return "multiline";
  if (Array.isArray(value)) {
    if (value.length > 1) return "list";
    const first = value.length ? String(value[0]) : "";
    return first.includes("\n") || first.length > 80 ? "multiline" : "scalar";
  }
  const text = value == null ? "" : String(value);
  return text.includes("\n") || text.length > 80 ? "multiline" : "scalar";
}

const TAB_BUILDERS: Record<OrcaPresetType, (fields: EditorField[]) => EditorTab[]> = {
  machine: buildMachineTabs,
  filament: buildFilamentTabs,
  process: buildProcessTabs,
};

/** Build the identity + tab-arranged model for a preset. */
export function buildEditorModel(json: OrcaPresetJson, type: OrcaPresetType): EditorModel {
  const identity: EditorField[] = [];
  const editable: EditorField[] = [];

  for (const key of Object.keys(json)) {
    if (key === "name") continue; // handled by the preset-name field
    const field: EditorField = { key, label: humanizeKey(key), control: fieldControl(json[key], key) };
    if (IDENTITY_KEYS.has(key)) identity.push(field);
    else editable.push(field);
  }

  identity.sort((a, b) => IDENTITY_ORDER.indexOf(a.key) - IDENTITY_ORDER.indexOf(b.key));

  return { identity, tabs: TAB_BUILDERS[type](editable) };
}
