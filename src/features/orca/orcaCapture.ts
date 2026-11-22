import type { OrcaProfileTags } from "./orcaProfileTags";
import type { PrinterConfigReference } from "../../types";

/** Versioned, slot-aware native capture. Values use Orca's own serialization. */
export const orcaCaptureFormat = "klippee-orca-setup/v1";
export type CaptureKind = "machine" | "process" | "filament";
export type OrcaCapture = {
  format: typeof orcaCaptureFormat;
  nodes: Record<string, {
    kind: CaptureKind; name: string; parent: string | null;
    saved: Record<string, string>; source_json: Record<string, unknown> | null;
  }>;
  selections: Array<{
    node: string; slot: number | null; dirty: boolean;
    effective: Record<string, string>; changes: Record<string, string>;
  }>;
};
export type OrcaSetupSummary = {
  id: string; printerId: string | null; title: string; createdAt: string;
  hostVersion: string; hostBuild: string; nodes: number; omittedKeys: string[];
  selections: Array<{ name: string; kind: CaptureKind; slot: number | null; dirty: boolean }>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const kind = (value: unknown): value is CaptureKind => typeof value === "string" && ["machine", "process", "filament"].includes(value);
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
// Connection/account metadata is not part of a portable slicing setup.
const privateKey = /password|passwd|secret|token|api_?key|access_?code|printhost|print_host|host_type|authorization|^(setting_id|base_id|user_id)$/i;
export const isOmittedCaptureKey = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && privateKey.test(value);

function sanitize(value: unknown, omitted: Set<string>, depth = 0): unknown {
  if (depth > 20) throw new Error("Preset metadata is too deeply nested");
  if (Array.isArray(value)) return value.map((item) => sanitize(item, omitted, depth + 1));
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (privateKey.test(key)) { omitted.add(key); return []; }
    return [[key, sanitize(item, omitted, depth + 1)]];
  }));
}

function settings(value: unknown): value is Record<string, string> {
  return record(value) && Object.keys(value).length <= 4096 && Object.values(value).every((item) => typeof item === "string");
}

function parseCapture(raw: unknown, extraRoots: string[] = []): { snapshot: OrcaCapture; omittedKeys: string[] } {
  if (!record(raw) || raw.format !== orcaCaptureFormat || !record(raw.nodes) || !Array.isArray(raw.selections)) {
    throw new Error("Unsupported OrcaSlicer capture");
  }
  const omitted = new Set<string>();
  const nodes: OrcaCapture["nodes"] = Object.create(null);
  const entries = Object.entries(raw.nodes);
  if (!entries.length || entries.length > (extraRoots.length ? 768 : 128)) throw new Error("Too many captured ancestry nodes");
  for (const [id, node] of entries) {
    if (!record(node) || !kind(node.kind) || !name(node.name) || id !== `${node.kind}:${node.name}`
      || !(node.parent === null || name(node.parent)) || !settings(node.saved)
      || !(node.source_json === null || record(node.source_json))) throw new Error("Invalid captured preset");
    nodes[id] = {
      kind: node.kind, name: node.name, parent: node.parent,
      saved: sanitize(node.saved, omitted) as Record<string, string>,
      source_json: sanitize(node.source_json, omitted) as Record<string, unknown> | null,
    };
  }
  for (const [id, node] of Object.entries(nodes)) {
    const visited = new Set([id]);
    let parent = node.parent;
    if ((node.saved.inherits ?? "") !== (parent ? nodes[parent]?.name : "")) throw new Error("Inheritance reference does not match captured parent");
    while (parent) {
      if (!has(nodes, parent) || nodes[parent].kind !== node.kind || visited.has(parent)) throw new Error("Missing or cyclic preset ancestry");
      visited.add(parent);
      parent = nodes[parent].parent;
    }
  }
  if (raw.selections.length < 3 || raw.selections.length > 34) throw new Error("Capture must include a printer, process and 1 to 32 filament slots");
  const selections = raw.selections.map((item, index): OrcaCapture["selections"][number] => {
    if (!record(item) || !name(item.node) || !has(nodes, item.node) || typeof item.dirty !== "boolean"
      || !settings(item.effective) || !settings(item.changes)) throw new Error("Invalid captured selection");
    const expectedKind = index === 0 ? "machine" : index === 1 ? "process" : "filament";
    if (nodes[item.node].kind !== expectedKind || item.slot !== (index < 2 ? null : index - 2)) throw new Error("Invalid captured filament order");
    if ((item.effective.inherits ?? "") !== (nodes[item.node].saved.inherits ?? "")) throw new Error("Edited inheritance is unsupported");
    const effective = sanitize(item.effective, omitted) as Record<string, string>;
    const saved = nodes[item.node].saved;
    if (Object.keys(saved).some((key) => !has(effective, key))) throw new Error("Edited preset removed settings");
    return { node: item.node, slot: index < 2 ? null : index - 2, dirty: item.dirty, effective,
      changes: Object.fromEntries(Object.entries(effective).filter(([key, value]) => saved[key] !== value && key !== "extruder_nozzle_stats")) };
  });
  // Do not accept unrelated payloads hidden alongside the selected setup.
  const reachable = new Set<string>();
  for (const root of [...selections.map((item) => item.node), ...extraRoots]) {
    if (!has(nodes, root)) throw new Error("Missing library profile");
    let id: string | null = root;
    while (id && !reachable.has(id)) { reachable.add(id); id = nodes[id].parent; }
  }
  if (reachable.size !== entries.length) throw new Error("Capture contains unrelated presets");
  return { snapshot: { format: orcaCaptureFormat, nodes, selections }, omittedKeys: [...omitted].sort() };
}

export function parseOrcaCapture(raw: unknown) { return parseCapture(raw); }

export type OrcaLibrary = {
  format: "klippee-orca-library/v1";
  nodes: OrcaCapture["nodes"];
  profiles: Array<{ node: string; custom: boolean; enabled: boolean }>;
  current: OrcaCapture;
};
export type OrcaLibrarySummary = {
  id: string; updatedAt: string; hostVersion: string;
  profiles: Array<{ id: string; name: string; kind: CaptureKind; custom: boolean; enabled: boolean;
    parent: string | null; nozzle: string; printerIds: string[]; tags?: OrcaProfileTags; publicUrl?: string;
    autoUpdateEnabled?: boolean; autoUpdateError?: string | null; printerConfig?: PrinterConfigReference | null }>;
};

export function parseOrcaLibrary(raw: unknown): { library: OrcaLibrary; omittedKeys: string[] } {
  if (!record(raw) || raw.format !== "klippee-orca-library/v1" || !Array.isArray(raw.profiles)
    || !raw.profiles.length || raw.profiles.length > 768) throw new Error("Invalid Orca profile library");
  const profiles = raw.profiles.map((item) => {
    if (!record(item) || !name(item.node) || typeof item.custom !== "boolean" || typeof item.enabled !== "boolean") throw new Error("Invalid library profile");
    return { node: item.node, custom: item.custom, enabled: item.enabled };
  });
  if (new Set(profiles.map((item) => item.node)).size !== profiles.length) throw new Error("Duplicate library profile");
  const current = parseOrcaCapture(raw.current);
  const parsed = parseCapture({ ...current.snapshot, nodes: raw.nodes }, profiles.map((item) => item.node));
  for (const profile of profiles) {
    const node = parsed.snapshot.nodes[profile.node];
    if (!profile.custom && !(node.kind === "machine" && profile.enabled)) throw new Error("Library contains profiles outside the selected scope");
  }
  for (const [id, node] of Object.entries(current.snapshot.nodes)) {
    if (JSON.stringify(node) !== JSON.stringify(parsed.snapshot.nodes[id])) throw new Error("Library and current setup disagree");
  }
  return { library: { format: "klippee-orca-library/v1", nodes: parsed.snapshot.nodes, profiles, current: current.snapshot },
    omittedKeys: [...new Set([...parsed.omittedKeys, ...current.omittedKeys])].sort() };
}

export function captureSelections(snapshot: OrcaCapture): OrcaSetupSummary["selections"] {
  return snapshot.selections.map((item) => ({ name: snapshot.nodes[item.node].name,
    kind: snapshot.nodes[item.node].kind, slot: item.slot, dirty: item.dirty }));
}
