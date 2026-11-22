import type { OrcaLibrarySummary } from "./orcaCapture";

export type OrcaProfileTags = {
  nozzleSizes: string[];
  nozzleScope: "specific" | "unrestricted" | "unknown";
  materials: string[];
  layerHeights: string[];
  printerModels: string[];
  hasCompatibilityRule: boolean;
};

export type OrcaTagNode = {
  id: string; parentId: string | null;
  nozzle: string | null; compatiblePrinters: string | null; compatibilityCondition: string | null;
  material: string | null; layerHeight: string | null; printerModel: string | null;
};

// Orca serializes string vectors as semicolon-separated CSV, with quotes and
// backslash escapes. JSON arrays also occur in fixtures and exported metadata.
function stringValues(raw: string | null): string[] | null {
  const text = raw?.trim() ?? "";
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const values: unknown = JSON.parse(text);
      return Array.isArray(values) && values.every(value => typeof value === "string" || typeof value === "number")
        ? values.map(String) : null;
    } catch { return null; }
  }
  const result: string[] = [];
  let value = "", quoted = false, escaped = false;
  for (const character of text) {
    if (escaped) { value += character; escaped = false; }
    else if (character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (character === ";" && !quoted) { result.push(value.trim()); value = ""; }
    else value += character;
  }
  if (quoted || escaped) return null;
  result.push(value.trim());
  return result.filter(Boolean);
}

const unique = (values: string[]) => [...new Set(values.filter(value => value.length <= 120))]
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 32);
export function orcaDimensions(raw: string | null): string[] {
  return unique((stringValues(raw) ?? []).flatMap(value => value.split(",")).flatMap(value => {
    const numeric = value.trim();
    return /^\d*\.?\d+$/.test(numeric) && Number(numeric) > 0 && Number(numeric) <= 10 ? [String(Number(numeric))] : [];
  }));
}

/** Derive display metadata from the saved graph, without changing preset data. */
export function tagOrcaProfiles(profiles: OrcaLibrarySummary["profiles"], rows: OrcaTagNode[]) {
  const nodes = new Map(rows.map(row => [row.id, row]));
  function setting(id: string, key: Exclude<keyof OrcaTagNode, "id" | "parentId">): string | null {
    const visited = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const node = nodes.get(cursor);
      if (!node) return null;
      if (node[key] !== null) return node[key];
      cursor = node.parentId;
    }
    return null;
  }
  return profiles.map(profile => {
    const hasCompatibilityRule = Boolean(setting(profile.id, "compatibilityCondition")?.trim());
    const targets = stringValues(setting(profile.id, "compatiblePrinters"));
    const machine = profile.kind === "machine";
    const targetIds = machine ? [profile.id] : (targets ?? []).map(name => `machine:${name}`);
    const nozzleSizes = unique(targetIds.flatMap(id => orcaDimensions(setting(id, "nozzle"))));
    const resolved = targetIds.length > 0 && targetIds.every(id => orcaDimensions(setting(id, "nozzle")).length > 0);
    const tags: OrcaProfileTags = {
      nozzleSizes,
      nozzleScope: resolved ? "specific" : !machine && nodes.has(profile.id) && targets?.length === 0 && !hasCompatibilityRule ? "unrestricted" : "unknown",
      materials: unique(stringValues(setting(profile.id, "material")) ?? []),
      layerHeights: orcaDimensions(setting(profile.id, "layerHeight")),
      printerModels: unique(targetIds.flatMap(id => stringValues(setting(id, "printerModel")) ?? [])),
      hasCompatibilityRule,
    };
    return { ...profile, tags };
  });
}

export function orcaProfileTags(profile: OrcaLibrarySummary["profiles"][number]): OrcaProfileTags {
  if (profile.tags) return profile.tags;
  const nozzleSizes = profile.kind === "machine" ? orcaDimensions(profile.nozzle) : [];
  return { nozzleSizes, nozzleScope: nozzleSizes.length ? "specific" : "unknown", materials: [], layerHeights: [], printerModels: [], hasCompatibilityRule: false };
}

export function orcaProfileTagLabels(tags: OrcaProfileTags): string[] {
  return [...new Set([
    ...tags.nozzleSizes.map(size => `${size} mm nozzle`),
    ...(tags.nozzleScope === "unrestricted" ? ["No nozzle restriction"] : tags.nozzleScope === "unknown" ? ["Nozzle unspecified"] : []),
    ...tags.materials,
    ...tags.layerHeights.map(height => `${height} mm layer`),
    ...tags.printerModels,
    ...(tags.hasCompatibilityRule ? ["Orca compatibility rule"] : []),
  ])];
}
