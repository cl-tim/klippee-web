import { describe, expect, it } from "vitest";
import type { OrcaLibrarySummary } from "./orcaCapture";
import { orcaLibraryProfiles } from "./orcaLibraryPresentation";

const root = "_local/klippee-restore-701648225c90";
const saved = `${root}-d1/saved-43f13e10cc2362a93c46`;
function profile(name: string, custom = false): OrcaLibrarySummary["profiles"][number] {
  return { id: `machine:${name}`, name, custom, kind: "machine", enabled: true, nozzle: "0.6", parent: saved, printerIds: ["example1"] };
}

describe("Orca library presentation", () => {
  it("hides generated dependencies while preserving restored profile identities and source data", () => {
    const restored = profile(`${root}-d2/restored-0-example1-0.6mm`);
    const input = [profile(saved), restored];
    const before = structuredClone(input);
    expect(orcaLibraryProfiles(input)).toEqual([{
      ...restored, displayName: "example1 0.6mm", sourceLabel: "Restored", parentDisplayName: "Restore dependency",
    }]);
    expect(input).toEqual(before);
  });

  it("keeps ordinary user, built-in and unrelated local presets with accurate labels", () => {
    expect(orcaLibraryProfiles([
      profile("QIDI factory profile"), profile("example1", true), profile("_local/my-bundle/My printer"),
      profile("saved-43f13e10cc2362a93c46", true), profile(`${root}-d1/saved-my-own-profile`, true),
    ]).map(({ displayName, sourceLabel }) => [displayName, sourceLabel])).toEqual([
      ["QIDI factory profile", "Built-in"], ["example1", "Custom"], ["_local/my-bundle/My printer", "Local"],
      ["saved-43f13e10cc2362a93c46", "Custom"], [`${root}-d1/saved-my-own-profile`, "Custom"],
    ]);
  });

  it("retains separate copies, nozzle variants and every preset kind", () => {
    const entries = [
      profile(`${root}-d2/restored-0-example1-0.6mm`, true),
      profile("_local/klippee-restore-79c071b78ba3-d2/restored-0-example1-0.6mm"),
      { ...profile(`${root}-d2/restored-1-0.20mm_Standard`), kind: "process" as const },
      { ...profile(`${root}-d2/restored-2-Generic-PLA`), kind: "filament" as const },
    ];
    const displayed = orcaLibraryProfiles(entries);
    expect(displayed.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    expect(displayed.map((entry) => entry.displayName)).toEqual(["example1 0.6mm", "example1 0.6mm", "0.20mm Standard", "Generic PLA"]);
    expect(displayed.every((entry) => entry.sourceLabel === "Restored")).toBe(true);
  });
});
