// OrcaSlicer preset parsing with lossless round-trips.
//
// OrcaSlicer user presets are JSON. Almost every *setting* value is stored as an
// array of strings even when it is logically a single value
// (e.g. `"nozzle_temperature": ["210"]`), while a handful of metadata keys
// (`type`, `name`, `inherits`, `from`, `setting_id`) are plain strings. User
// presets typically only override a subset of keys and rely on `inherits` to
// pull the rest from a system base. That means an editor that only understands
// a curated set of keys MUST preserve everything it does not recognise —
// unknown keys, the inheritance chain, and each value's array-vs-string shape —
// or re-export silently corrupts the preset.
//
// The full parsed JSON object is the source of truth. The form reads display
// strings via `getPresetField` and writes edits back via `setPresetField`,
// which preserves the original container shape of each value.

export type OrcaPresetType = "filament" | "machine" | "process";

/** Shape hint for how a curated field maps onto its underlying JSON value. */
export type OrcaFieldShape = "scalar" | "multiline" | "list";

export type OrcaPresetJson = Record<string, unknown>;

export type ParsedOrcaPreset = {
  type: OrcaPresetType;
  /** The preset's `name` metadata, or "" when absent. */
  name: string;
  /** Parent preset referenced via `inherits`, or null. */
  inherits: string | null;
  /** The complete parsed object — the source of truth for round-trips. */
  json: OrcaPresetJson;
};

const PRESET_TYPES: readonly OrcaPresetType[] = ["filament", "machine", "process"];

function readMetaString(value: unknown): string | null {
  if (typeof value === "string") return value;
  // Be lenient: some exporters wrap even metadata in a single-element array.
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

// OrcaSlicer user presets almost never carry a `type` field — they are
// identified by the folder they live in and by a settings-id key. Map each
// discriminator to its preset type. Order matters: "printer_settings_id" must
// be checked before "print_settings_id" (both start with "print").
const SETTINGS_ID_DISCRIMINATORS: ReadonlyArray<[string, OrcaPresetType]> = [
  ["printer_settings_id", "machine"],
  ["print_settings_id", "process"],
  ["filament_settings_id", "filament"],
];

/**
 * Determine the OrcaSlicer preset type from a parsed object, or null when the
 * object is not a recognisable preset.
 *
 * Prefers an explicit `type` field ("printer" is an alias for "machine") when
 * present — some exports and config bundles include it — but real single-preset
 * exports omit it, so it falls back to the settings-id discriminator that every
 * user preset carries.
 */
export function detectPresetType(json: OrcaPresetJson): OrcaPresetType | null {
  const raw = readMetaString(json.type);
  if (raw) {
    const normalized = raw === "printer" ? "machine" : raw;
    if (PRESET_TYPES.includes(normalized as OrcaPresetType)) {
      return normalized as OrcaPresetType;
    }
  }
  for (const [key, type] of SETTINGS_ID_DISCRIMINATORS) {
    if (key in json) return type;
  }
  return null;
}

/**
 * Parse OrcaSlicer preset JSON text. Returns null when the text is not valid
 * JSON, is not an object, or is not a recognisable preset (see
 * detectPresetType).
 */
export function parseOrcaPreset(text: string): ParsedOrcaPreset | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const json = parsed as OrcaPresetJson;
  const type = detectPresetType(json);
  if (!type) return null;

  return {
    type,
    name: readMetaString(json.name) ?? "",
    inherits: readMetaString(json.inherits),
    json,
  };
}

/** Serialise a preset back to JSON text using OrcaSlicer's 4-space indentation. */
export function serializeOrcaPreset(json: OrcaPresetJson): string {
  return JSON.stringify(json, null, 4);
}

/** A human-friendly display name for a parsed preset. */
export function presetDisplayName(preset: ParsedOrcaPreset): string {
  return preset.name.trim() || "Untitled preset";
}

/**
 * Read a curated field as a display string.
 * - `scalar`  → first array element (or the plain string).
 * - `multiline` → array joined by newlines (or the plain string).
 * - `list`    → array joined by ", ".
 */
export function getPresetField(json: OrcaPresetJson, key: string, shape: OrcaFieldShape): string {
  const value = json[key];
  if (value == null) return "";
  if (Array.isArray(value)) {
    // `list` values are edited one element per line.
    if (shape === "list") return value.map((entry) => String(entry)).join("\n");
    if (shape === "multiline") return value.map((entry) => String(entry)).join("\n");
    return value.length ? String(value[0]) : "";
  }
  return String(value);
}

/**
 * Write a curated field back into the JSON, preserving the original value's
 * container shape so unknown consumers still round-trip. Returns a new object;
 * the input is not mutated. Keys the preset never had are added using
 * OrcaSlicer's conventional shape (array for scalar/list, string for gcode).
 */
export function setPresetField(
  json: OrcaPresetJson,
  key: string,
  value: string,
  shape: OrcaFieldShape,
): OrcaPresetJson {
  const next: OrcaPresetJson = { ...json };
  const existed = key in json;
  const wasArray = Array.isArray(json[key]);

  if (value === "") {
    // Preserve the key's presence (an override that clears a value) but do not
    // materialise a brand-new empty key — that would add noise the user never
    // asked for and could shadow an inherited default.
    if (!existed) return next;
    next[key] = wasArray ? [""] : "";
    return next;
  }

  if (shape === "list") {
    next[key] = value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    return next;
  }

  if (shape === "multiline") {
    // OrcaSlicer stores gcode blocks as a single string; only keep an array
    // container if the source file already used one.
    next[key] = wasArray ? value.split("\n") : value;
    return next;
  }

  // scalar: OrcaSlicer's convention is a single-element array. Keep a plain
  // string only when the source explicitly used one.
  next[key] = existed && !wasArray ? value : [value];
  return next;
}
