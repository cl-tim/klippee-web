import { isOmittedCaptureKey } from "./orcaCapture";
import { scanPublicConfigFiles, type SafetyFinding } from "../../safety";
import type { CompanionAsset, PrinterConfigReference } from "../../types";

export type OrcaPublicationReview = {
  importId: string; candidateHash: string; title: string; description: string;
  kind: CompanionAsset["kind"]; content: string; tags: string[];
  findings: SafetyFinding[]; publicUrl: string | null;
  autoUpdateEnabled?: boolean; autoUpdateError?: string | null;
  printerConfig?: PrinterConfigReference | null; printerConfigs?: PrinterConfigReference[];
};
export type OrcaPublicationSettings = {
  autoUpdateEnabled: boolean; autoUpdateError: string | null; printerConfig: PrinterConfigReference | null;
};
export type PublicProfileSummary = Pick<CompanionAsset,
  "kind" | "title" | "description" | "tags" | "publicSlug" | "publishedAt" | "version">;

/** Repeat credential removal for older imports before building a public copy. */
export function sanitizePublicOrcaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePublicOrcaValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isOmittedCaptureKey(key))
    .map(([key, child]) => [key, sanitizePublicOrcaValue(child)]));
}

export function scanOrcaPublication(value: unknown): SafetyFinding[] {
  const lines: string[] = [];
  function visit(item: unknown, key = "") {
    if (typeof item === "string") lines.push(`${key}: ${item}`);
    else if (Array.isArray(item)) item.forEach(child => visit(child, key));
    else if (item && typeof item === "object") Object.entries(item).forEach(([name, child]) => visit(child, name));
  }
  visit(value);
  return scanPublicConfigFiles([{ path: "orca-profile.json", content: lines.join("\n") }]);
}

export function isNativeOrcaProfile(content: string): boolean {
  try { return JSON.parse(content)?.snapshot?.format === "klippee-orca-profile/v1"; }
  catch { return false; }
}
