import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  isBundleName,
  ORCA_BUNDLE_LIMITS,
  orcaBundleCompressedSizeError,
  orcaPresetFileSizeError,
  readOrcaBundle,
  readOrcaImport,
  readOrcaPresetFile,
} from "./orcaBundle";

const filament = JSON.stringify({ type: "filament", name: "PLA", nozzle_temperature: ["210"] });
const machine = JSON.stringify({ type: "machine", name: "Voron", nozzle_diameter: ["0.4"] });

function replaceZipDeclaredSize(bytes: Uint8Array, declaredSize: number) {
  const forged = bytes.slice();
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  for (let offset = 0; offset <= forged.byteLength - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint32(offset + 22, declaredSize, true);
    if (signature === 0x02014b50) view.setUint32(offset + 24, declaredSize, true);
  }
  return forged;
}

describe("isBundleName", () => {
  it("recognises OrcaSlicer bundle extensions and zips", () => {
    expect(isBundleName("MyFilament.orca_filament")).toBe(true);
    expect(isBundleName("Printer.ORCA_PRINTER")).toBe(true);
    expect(isBundleName("stuff.zip")).toBe(true);
    expect(isBundleName("preset.json")).toBe(false);
  });
});

describe("readOrcaPresetFile", () => {
  it("returns an entry for a valid preset", () => {
    const result = readOrcaPresetFile("PLA.json", filament);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].preset.type).toBe("filament");
    expect(result.entries[0].raw).toBe(filament);
  });

  it("reports a reason for a non-preset", () => {
    const result = readOrcaPresetFile("junk.json", "{}");
    expect(result.entries).toHaveLength(0);
    expect(result.errors[0]).toContain("not a recognisable OrcaSlicer preset");
  });
});

describe("readOrcaBundle", () => {
  it("unpacks every JSON preset and skips non-JSON members", () => {
    const zipped = zipSync({
      "filament/PLA.json": strToU8(filament),
      "printer/Voron.json": strToU8(machine),
      "BUNDLE_INFO.txt": strToU8("version=1"),
    });
    const result = readOrcaBundle("bundle.orca_filament", zipped);
    expect(result.errors).toEqual([]);
    expect(result.entries.map((entry) => entry.preset.type).sort()).toEqual(["filament", "machine"]);
  });

  it("imports every preset in a printer config bundle and skips the manifest", () => {
    // Mirrors a real .orca_printer: printer + filament + process presets (all
    // typeless, folder-organised) plus a bundle_structure.json manifest.
    const zipped = zipSync({
      "printer/example1.json": strToU8(JSON.stringify({ name: "example1", printer_settings_id: "example1" })),
      "filament/PETG.json": strToU8(JSON.stringify({ name: "PETG", filament_settings_id: ["PETG"] })),
      "process/0.20mm.json": strToU8(JSON.stringify({ name: "0.20mm", print_settings_id: "0.20mm" })),
      "bundle_structure.json": strToU8(JSON.stringify({ bundle_type: "printer config bundle", printer_config: ["printer/example1.json"] })),
    });
    const result = readOrcaBundle("example1.orca_printer", zipped);
    expect(result.errors).toEqual([]);
    expect(result.entries.map((entry) => entry.preset.type).sort()).toEqual(["filament", "machine", "process"]);
  });

  it("reports when a bundle contains no presets", () => {
    const zipped = zipSync({ "README.txt": strToU8("nothing here") });
    const result = readOrcaBundle("empty.orca_printer", zipped);
    expect(result.entries).toHaveLength(0);
    expect(result.errors[0]).toContain("no preset JSON found");
  });

  it("reports unreadable archives instead of throwing", () => {
    const result = readOrcaBundle("broken.zip", strToU8("this is not a zip"));
    expect(result.entries).toHaveLength(0);
    expect(result.errors[0]).toContain("could not be read as a zip bundle");
  });

  it("rejects oversized plain presets before the browser reads them", () => {
    expect(orcaPresetFileSizeError("large.json", ORCA_BUNDLE_LIMITS.memberBytes + 1)).toContain(
      "500 KiB size limit",
    );
  });

  it("rejects an oversized compressed bundle before reading or expanding it", () => {
    expect(
      orcaBundleCompressedSizeError("large.zip", ORCA_BUNDLE_LIMITS.compressedBytes + 1),
    ).toContain("8 MiB compressed-size limit");
    const result = readOrcaBundle(
      "large.zip",
      new Uint8Array(ORCA_BUNDLE_LIMITS.compressedBytes + 1),
    );
    expect(result.entries).toEqual([]);
    expect(result.errors[0]).toContain("8 MiB compressed-size limit");
  });

  it("rejects archives with too many members before expanding them", () => {
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index <= ORCA_BUNDLE_LIMITS.entryCount; index += 1) {
      files[`metadata/${index}.txt`] = strToU8("x");
    }
    const result = readOrcaBundle("crowded.zip", zipSync(files));
    expect(result.entries).toEqual([]);
    expect(result.errors[0]).toContain(`more than ${ORCA_BUNDLE_LIMITS.entryCount} entries`);
  });

  it("rejects a preset whose declared expanded size exceeds the member cap", () => {
    const oversizedPreset = JSON.stringify({
      type: "filament",
      name: "Oversized",
      padding: "x".repeat(ORCA_BUNDLE_LIMITS.memberBytes),
    });
    const result = readOrcaBundle(
      "member-bomb.zip",
      zipSync({ "filament/Oversized.json": strToU8(oversizedPreset) }),
    );
    expect(result.entries).toEqual([]);
    expect(result.errors[0]).toContain("500 KiB per-entry limit");
  });

  it("counts streamed output instead of trusting forged ZIP size metadata", () => {
    const oversizedPreset = JSON.stringify({
      type: "filament",
      name: "Forged",
      padding: "x".repeat(ORCA_BUNDLE_LIMITS.memberBytes),
    });
    const zipped = zipSync({ "filament/Forged.json": strToU8(oversizedPreset) }, { level: 9 });
    const result = readOrcaBundle("forged-size.zip", replaceZipDeclaredSize(zipped, 1));
    expect(result.entries).toEqual([]);
    expect(result.errors[0]).toContain("500 KiB per-entry limit");
  });

  it("rejects bundles whose preset members exceed the total expanded cap", () => {
    const files: Record<string, Uint8Array> = {};
    const member = strToU8(JSON.stringify({
      type: "filament",
      name: "Large",
      padding: "x".repeat(ORCA_BUNDLE_LIMITS.memberBytes - 1_000),
    }));
    const count = Math.floor(ORCA_BUNDLE_LIMITS.totalExpandedBytes / member.byteLength) + 1;
    for (let index = 0; index < count; index += 1) files[`filament/${index}.json`] = member;

    const result = readOrcaBundle("total-bomb.zip", zipSync(files));
    expect(result.entries).toEqual([]);
    expect(result.errors[0]).toContain("8 MiB total limit");
  });
});

describe("readOrcaImport dispatch", () => {
  it("routes bundles through the unpacker and plain files through the JSON reader", () => {
    const zipped = zipSync({ "PLA.json": strToU8(filament) });
    expect(readOrcaImport("b.orca_filament", zipped, "").entries).toHaveLength(1);
    expect(readOrcaImport("PLA.json", new Uint8Array(), filament).entries).toHaveLength(1);
  });
});
