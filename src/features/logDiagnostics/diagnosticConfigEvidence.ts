import type {
  DiagnosticConfigEvidence,
  DiagnosticConfigSection,
  DiagnosticFinding,
  FailureFamily,
} from "./types";

const maximumConfigSections = 160;
const maximumOptionsPerSection = 80;
const maximumPendingItems = 100;
const maximumWarnings = 50;

export function parseDiagnosticConfigEvidence(value: unknown): DiagnosticConfigEvidence | null {
  const configfile = recordValue(value);
  if (!configfile) return null;
  const settings = recordValue(configfile.settings) ?? recordValue(configfile.config);
  const sectionEntries = settings ? Object.entries(settings) : [];
  const sections = sectionEntries.flatMap(([name, options]): DiagnosticConfigSection[] => {
    const kind = configSectionKind(name);
    const values = recordValue(options);
    if (!kind || !values) return [];
    return [{
      kind,
      name: name.slice(0, 160),
      options: normalizeOptions(values),
    }];
  }).slice(0, maximumConfigSections);
  const warnings = Array.isArray(configfile.warnings)
    ? configfile.warnings.slice(0, maximumWarnings).flatMap((raw): DiagnosticConfigEvidence["warnings"] => {
      const warning = recordValue(raw);
      const message = stringValue(warning?.message, 1_200);
      if (!message) return [];
      return [{
        message,
        type: stringValue(warning?.type, 80) || "warning",
      }];
    })
    : [];
  const pendingSaveItems = flattenPendingItems(configfile.save_config_pending_items).slice(0, maximumPendingItems);
  const pendingSave = configfile.save_config_pending === true || pendingSaveItems.length > 0;
  if (!settings && !warnings.length && !pendingSave) return null;
  return {
    pendingSave,
    pendingSaveItems,
    retainedSectionCount: sections.length,
    sectionCount: sectionEntries.length,
    sections,
    warnings,
  };
}

export function buildDiagnosticConfigFindings(
  config: DiagnosticConfigEvidence,
  session: number,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  if (config.pendingSave) {
    const items = config.pendingSaveItems.length
      ? config.pendingSaveItems.slice(0, 20).join(", ")
      : "Klipper did not report the changed item names";
    findings.push({
      checks: [
        "Review the pending values before running SAVE_CONFIG.",
        "If these are intentional calibration results, save them before restarting Klipper.",
        "If they are not intentional, restart without saving and repeat the relevant calibration.",
      ],
      confidence: "observed",
      detail: `Klipper had configuration changes waiting for SAVE_CONFIG at bundle capture. Pending items: ${items}.`,
      evidence: [configEvidence(`save_config_pending: true; ${items}`, session)],
      family: "configuration",
      id: "bundle-config-save-pending",
      session,
      severity: "warning",
      title: "Klipper had unsaved configuration changes",
    });
  }
  if (config.warnings.length) {
    findings.push({
      checks: [
        "Review each warning against the active Klipper version and configuration reference.",
        "Remove obsolete options and correct deprecated values before the next upgrade.",
        "Restart Klipper after editing and confirm the warnings are gone.",
      ],
      confidence: "observed",
      detail: `Klipper reported ${config.warnings.length} active configuration warning${config.warnings.length === 1 ? "" : "s"} at bundle capture.`,
      evidence: config.warnings.slice(0, 5).map((warning) =>
        configEvidence(`${warning.type}: ${warning.message}`, session)),
      family: "configuration",
      id: "bundle-klipper-config-warnings",
      session,
      severity: "warning",
      title: "Klipper reported configuration warnings",
    });
  }
  return findings;
}

export function correlateFindingsWithDiagnosticConfig(
  findings: DiagnosticFinding[],
  config: DiagnosticConfigEvidence,
): DiagnosticFinding[] {
  return findings.map((finding) => {
    const sections = relevantSections(finding, config.sections);
    if (!sections.length) return finding;
    const summaries = sections.slice(0, 4).map(formatSectionSummary);
    const context = summaries.join(" | ");
    return {
      ...finding,
      checks: [
        "Confirm the correlated active Klipper settings match the installed hardware before changing pins, sensor models, communication paths, or safety limits.",
        ...finding.checks,
      ],
      detail: `${finding.detail} Active configuration: ${context}.`,
      evidence: [
        ...finding.evidence,
        {
          line: 1,
          message: context,
          session: finding.session,
          source: "snapshots/printer-objects.json#configfile",
          time: null,
        },
      ],
    };
  });
}

function relevantSections(
  finding: DiagnosticFinding,
  sections: DiagnosticConfigSection[],
) {
  if (finding.id === "probe-no-trigger") {
    return sections.filter((section) =>
      section.kind === "probe" && /^(?:probe|probe_eddy_current|bltouch|beacon|load_cell_probe)(?:\s|$)/i.test(section.name)
      || ["stepper_z", "quad_gantry_level", "z_tilt"].includes(section.name.toLowerCase()));
  }
  const text = [
    finding.title,
    finding.detail,
    ...finding.evidence.map((evidence) => evidence.message),
  ].join(" ").toLowerCase();
  const kinds = relevantKinds(finding.family);
  const direct = sections.filter((section) =>
    kinds.has(section.kind) && mentionsSection(text, section));
  if (!direct.length) {
    return kinds.has("motion")
      ? sections.filter((section) => section.name.toLowerCase() === "printer").slice(0, 1)
      : [];
  }
  if (!kinds.has("heater")) return direct.slice(0, 4);
  const heaterNames = new Set(direct
    .filter((section) => section.kind === "heater")
    .map((section) => sectionAlias(section.name)));
  const verification = sections.filter((section) =>
    section.kind === "verification" && heaterNames.has(sectionAlias(section.name)));
  return [...direct, ...verification.filter((section) => !direct.includes(section))].slice(0, 4);
}

function relevantKinds(family: FailureFamily): Set<DiagnosticConfigSection["kind"]> {
  if (family === "communication" || family === "firmware") return new Set(["mcu"]);
  if (family === "heating" || family === "sensor") return new Set(["heater", "sensor", "verification"]);
  if (family === "motion" || family === "stepper") return new Set(["motion"]);
  if (family === "probe") return new Set(["probe"]);
  return new Set();
}

function mentionsSection(text: string, section: DiagnosticConfigSection) {
  const name = section.name.toLowerCase();
  const alias = sectionAlias(name);
  if (name === "mcu") return /mcu ['"]mcu['"]|mcu mcu\b/.test(text);
  if (name === "printer") return false;
  return text.includes(name) || (alias.length >= 3 && text.includes(alias));
}

function sectionAlias(name: string) {
  return name.toLowerCase()
    .replace(/^(?:heater_generic|mcu|temperature_sensor|temperature_fan|verify_heater)\s+/, "")
    .trim();
}

function formatSectionSummary(section: DiagnosticConfigSection) {
  const preferred = preferredKeys[section.kind];
  const keys = [
    ...preferred.filter((key) => section.options[key] !== undefined),
    ...Object.keys(section.options).filter((key) => !preferred.includes(key)).sort(),
  ].slice(0, 8);
  const values = keys.map((key) => `${key}=${section.options[key]}`).join(", ");
  return `[${section.name}]${values ? ` ${values}` : ""}`.slice(0, 1_200);
}

const preferredKeys: Record<DiagnosticConfigSection["kind"], string[]> = {
  heater: [
    "sensor_type",
    "sensor_pin",
    "heater_pin",
    "control",
    "max_power",
    "min_temp",
    "max_temp",
  ],
  mcu: ["serial", "canbus_uuid", "canbus_interface", "baud", "restart_method"],
  motion: [
    "step_pin",
    "dir_pin",
    "enable_pin",
    "rotation_distance",
    "microsteps",
    "endstop_pin",
    "position_min",
    "position_max",
  ],
  probe: ["pin", "sensor_pin", "control_pin", "x_offset", "y_offset", "z_offset", "speed", "descend_z"],
  sensor: ["sensor_type", "sensor_pin", "sensor_mcu", "min_temp", "max_temp"],
  system: ["kinematics", "max_velocity", "max_accel", "square_corner_velocity"],
  verification: ["max_error", "check_gain_time", "hysteresis", "heating_gain"],
};

function configSectionKind(name: string): DiagnosticConfigSection["kind"] | null {
  const normalized = name.toLowerCase();
  if (/^mcu(?:\s|$)/.test(normalized)) return "mcu";
  if (
    normalized === "extruder"
    || normalized === "heater_bed"
    || normalized.startsWith("heater_generic ")
  ) return "heater";
  if (normalized.startsWith("verify_heater ")) return "verification";
  if (
    normalized.startsWith("temperature_sensor ")
    || normalized.startsWith("temperature_fan ")
  ) return "sensor";
  if (
    normalized.startsWith("stepper_")
    || /^tmc[0-9]+ /.test(normalized)
    || ["printer", "safe_z_home", "quad_gantry_level", "z_tilt"].includes(normalized)
  ) return "motion";
  if (
    normalized === "probe"
    || normalized.startsWith("probe_eddy_current ")
    || normalized === "bltouch"
    || normalized === "beacon"
    || normalized === "load_cell_probe"
    || normalized.startsWith("bed_mesh")
  ) return "probe";
  if (normalized === "virtual_sdcard" || normalized === "pause_resume") return "system";
  return null;
}

function normalizeOptions(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value)
    .slice(0, maximumOptionsPerSection)
    .map(([key, raw]) => [key.slice(0, 120), normalizeOption(raw)]));
}

function normalizeOption(value: unknown) {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function flattenPendingItems(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (typeof item === "string") return [item.slice(0, 240)];
      return flattenPendingItems(item, `${prefix}${prefix ? "." : ""}${index}`);
    });
  }
  const record = recordValue(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, nested]) => {
    const path = `${prefix}${prefix ? "." : ""}${key}`.slice(0, 240);
    const child = flattenPendingItems(nested, path);
    return child.length ? child : [path];
  }).slice(0, maximumPendingItems);
}

function configEvidence(message: string, session: number) {
  return {
    line: 1,
    message: message.slice(0, 1_200),
    session,
    source: "snapshots/printer-objects.json#configfile",
    time: null,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown, maximum: number) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}
