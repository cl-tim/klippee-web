import { sha256Hex } from "./util";
import type { OrcaCapture, OrcaLibrarySummary } from "../src/features/orca/orcaCapture";
import { orcaLibraryProfiles } from "../src/features/orca/orcaLibraryPresentation";
import { orcaProfileTagLabels, orcaProfileTags, tagOrcaProfiles } from "../src/features/orca/orcaProfileTags";
import { sanitizePublicOrcaValue, scanOrcaPublication } from "../src/features/orca/orcaPublication";

// Include the owner: native preset IDs are shared between many accounts.
export async function orcaPublicationId(userId: string, profileId: string) {
  return `orca-library-${(await sha256Hex(`${userId}\0${profileId}`)).slice(0, 32)}`;
}

export function orcaPublicationProfiles(summary: OrcaLibrarySummary, all: OrcaCapture["nodes"]) {
  return orcaLibraryProfiles(tagOrcaProfiles(summary.profiles, Object.entries(all).map(([id, node]) => ({
    id, parentId: node.parent, nozzle: node.saved.nozzle_diameter ?? null,
    compatiblePrinters: node.saved.compatible_printers ?? null, compatibilityCondition: node.saved.compatible_printers_condition ?? null,
    material: node.saved.filament_type ?? null, layerHeight: node.saved.layer_height ?? null, printerModel: node.saved.printer_model ?? null,
  }))));
}

export async function buildOrcaPublication(summary: OrcaLibrarySummary, all: OrcaCapture["nodes"], profileId: string,
  profiles = orcaPublicationProfiles(summary, all)) {
  const profile = profiles.find(item => item.id === profileId);
  if (!profile) return { error: "Usable library profile not found.", status: 404 };
  const nodes: OrcaCapture["nodes"] = Object.create(null);
  let cursor: string | null = profileId;
  while (cursor) {
    if (!Object.hasOwn(all, cursor) || Object.hasOwn(nodes, cursor)) return { error: "Profile inheritance is incomplete. Import your library again.", status: 409 };
    nodes[cursor] = sanitizePublicOrcaValue(all[cursor]) as OrcaCapture["nodes"][string];
    cursor = nodes[cursor].parent;
  }
  const snapshot = { format: "klippee-orca-profile/v1", nodes,
    selections: [{ node: profileId, slot: null, dirty: false, effective: { ...nodes[profileId].saved }, changes: {} }] };
  const content = JSON.stringify({ snapshot }, null, 2), tags = orcaProfileTagLabels(orcaProfileTags(profile));
  if (new TextEncoder().encode(content).byteLength > 480_000) return { error: "This profile and its ancestors exceed the 480 KB publication limit. You can still export it privately.", status: 413 };
  return { candidate: { kind: profile.kind, title: profile.displayName.slice(0, 160), content, tags,
    candidateHash: await sha256Hex(JSON.stringify({ content, tags })), findings: scanOrcaPublication({ snapshot, tags }) } };
}
