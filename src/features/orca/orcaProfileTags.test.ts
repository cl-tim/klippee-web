import { describe, expect, it } from "vitest";
import type { OrcaLibrarySummary } from "./orcaCapture";
import { tagOrcaProfiles, type OrcaTagNode } from "./orcaProfileTags";

function node(id: string, values: Partial<OrcaTagNode> = {}): OrcaTagNode {
  return { id, parentId: null, nozzle: null, compatiblePrinters: null, compatibilityCondition: null, material: null, layerHeight: null, printerModel: null, ...values };
}
function profile(kind: "machine" | "process" | "filament", name: string): OrcaLibrarySummary["profiles"][number] {
  return { id: `${kind}:${name}`, name, kind, custom: true, enabled: true, parent: null, nozzle: "", printerIds: [] };
}

describe("Orca profile tags", () => {
  it("uses explicit printer compatibility for nozzle tags, and keeps layer height and material separate", () => {
    const profiles = [profile("process", "0.20mm quality"), profile("filament", "Fine PLA")];
    const rows = [
      node("machine:QIDI; Fine", { nozzle: "0.2", printerModel: "QIDI Plus 4" }),
      node("machine:QIDI standard", { nozzle: "0.4", printerModel: "QIDI Plus 4" }),
      node(profiles[0].id, { compatiblePrinters: '"QIDI standard"', layerHeight: "0.20" }),
      node(profiles[1].id, { compatiblePrinters: '"QIDI; Fine";"QIDI standard"', material: "PLA" }),
    ];
    const tagged = tagOrcaProfiles(profiles, rows);
    expect(tagged[0].tags).toMatchObject({ nozzleSizes: ["0.4"], layerHeights: ["0.2"], nozzleScope: "specific", printerModels: ["QIDI Plus 4"] });
    expect(tagged[1].tags).toMatchObject({ nozzleSizes: ["0.2", "0.4"], materials: ["PLA"], nozzleScope: "specific" });
  });

  it("resolves settings through ancestors and keeps explicit empty overrides", () => {
    const profiles = [profile("machine", "User printer"), profile("filament", "User PETG")];
    const tagged = tagOrcaProfiles(profiles, [
      node("machine:Base", { nozzle: "0.20,0.40", printerModel: "QIDI Plus 4" }),
      node(profiles[0].id, { parentId: "machine:Base" }),
      node("filament:Base", { compatiblePrinters: '"User printer"', material: "PETG" }),
      node(profiles[1].id, { parentId: "filament:Base", compatiblePrinters: "" }),
    ]);
    expect(tagged[0].tags.nozzleSizes).toEqual(["0.2", "0.4"]);
    expect(tagged[1].tags).toMatchObject({ nozzleSizes: [], nozzleScope: "unrestricted", materials: ["PETG"] });
  });

  it("does not infer nozzle sizes from titles, missing targets, malformed lists or compatibility expressions", () => {
    const profiles = ["0.20mm Standard", "Unresolved", "Broken", "Rule", "Missing"].map(name => profile("process", name));
    const tagged = tagOrcaProfiles(profiles, [
      node(profiles[0].id, { layerHeight: "0.20" }),
      node(profiles[1].id, { compatiblePrinters: '"Printer 0.2 nozzle"' }),
      node(profiles[2].id, { compatiblePrinters: '[bad json' }),
      node(profiles[3].id, { compatibilityCondition: 'nozzle_diameter[0] == 0.4 or printer_model == "Other"' }),
    ]);
    expect(tagged.every(item => item.tags.nozzleSizes.length === 0)).toBe(true);
    expect(tagged.map(item => item.tags.nozzleScope)).toEqual(["unrestricted", "unknown", "unknown", "unknown", "unknown"]);
    expect(tagged[3].tags.hasCompatibilityRule).toBe(true);
  });
});
