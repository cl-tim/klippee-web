// Reading OrcaSlicer imports: single `.json` presets and zipped preset bundles.
//
// OrcaSlicer's "Export preset bundle" produces `.orca_filament`,
// `.orca_printer`, and `.orca_process` files, which are ordinary zip archives
// containing one or more preset JSON members (plus incidental metadata files we
// ignore). These helpers are intentionally DOM-free — the view reads a File
// into text/bytes and hands them here — so they can be unit-tested directly.

import { strFromU8, Unzip, UnzipInflate } from "fflate";
import { parseOrcaPreset, type ParsedOrcaPreset } from "./orcaPreset";

export type OrcaImportEntry = {
  /** Source label — the file name, or `file:member` for a bundle member. */
  source: string;
  preset: ParsedOrcaPreset;
  /** The original JSON text, preserved verbatim as the source of truth. */
  raw: string;
};

export type OrcaImportResult = {
  entries: OrcaImportEntry[];
  /** Human-readable, per-file reasons an input was skipped. */
  errors: string[];
};

const BUNDLE_EXTENSIONS = [".orca_filament", ".orca_printer", ".orca_process", ".zip"];

export const ORCA_BUNDLE_LIMITS = Object.freeze({
  compressedBytes: 8 * 1024 * 1024,
  entryCount: 128,
  memberBytes: 512_000,
  totalExpandedBytes: 8 * 1024 * 1024,
});

class OrcaBundleLimitError extends Error {}

const ZIP_INPUT_CHUNK_BYTES = 1024;

/** Last path segment of a zip member name (members use forward slashes). */
function basename(memberName: string): string {
  const parts = memberName.split("/");
  return parts[parts.length - 1];
}

/** True when the file name looks like a zipped OrcaSlicer bundle. */
export function isBundleName(name: string): boolean {
  const lower = name.toLowerCase();
  return BUNDLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Validate the compressed size before a browser reads the whole File. */
export function orcaBundleCompressedSizeError(fileName: string, size: number): string | null {
  if (!Number.isSafeInteger(size) || size < 0) {
    return `${fileName}: bundle has an invalid compressed size`;
  }
  if (size > ORCA_BUNDLE_LIMITS.compressedBytes) {
    return `${fileName}: bundle exceeds the 8 MiB compressed-size limit`;
  }
  return null;
}

/** Validate a plain preset before a browser reads the whole File. */
export function orcaPresetFileSizeError(fileName: string, size: number): string | null {
  if (!Number.isSafeInteger(size) || size < 0) {
    return `${fileName}: preset has an invalid size`;
  }
  if (size > ORCA_BUNDLE_LIMITS.memberBytes) {
    return `${fileName}: preset exceeds the 500 KiB size limit`;
  }
  return null;
}

function joinChunks(chunks: Uint8Array[], byteLength: number) {
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function extractPresetMembers(fileName: string, bytes: Uint8Array) {
  const signature = bytes.byteLength >= 4
    ? new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
    : 0;
  if (![0x04034b50, 0x06054b50, 0x08074b50].includes(signature)) {
    throw new Error("Invalid ZIP signature");
  }
  const members: Array<{ data: Uint8Array; name: string }> = [];
  let entryCount = 0;
  let totalExpandedBytes = 0;
  const unzipper = new Unzip((member) => {
    entryCount += 1;
    if (entryCount > ORCA_BUNDLE_LIMITS.entryCount) {
      throw new OrcaBundleLimitError(
        `${fileName}: bundle contains more than ${ORCA_BUNDLE_LIMITS.entryCount} entries`,
      );
    }

    const lowerName = member.name.toLowerCase();
    const isPreset = lowerName.endsWith(".json") && basename(lowerName) !== "bundle_structure.json";
    if (!isPreset) return;
    if (
      member.originalSize !== undefined
      && (!Number.isSafeInteger(member.originalSize) || member.originalSize < 0)
    ) {
      throw new OrcaBundleLimitError(`${fileName}:${member.name}: has an invalid expanded size`);
    }
    if (
      member.originalSize !== undefined
      && member.originalSize > ORCA_BUNDLE_LIMITS.memberBytes
    ) {
      throw new OrcaBundleLimitError(
        `${fileName}:${member.name}: expands beyond the 500 KiB per-entry limit`,
      );
    }

    const chunks: Uint8Array[] = [];
    let memberBytes = 0;
    member.ondata = (error, data, final) => {
      if (error) throw error;
      memberBytes += data.byteLength;
      totalExpandedBytes += data.byteLength;
      if (memberBytes > ORCA_BUNDLE_LIMITS.memberBytes) {
        member.terminate();
        throw new OrcaBundleLimitError(
          `${fileName}:${member.name}: expands beyond the 500 KiB per-entry limit`,
        );
      }
      if (totalExpandedBytes > ORCA_BUNDLE_LIMITS.totalExpandedBytes) {
        member.terminate();
        throw new OrcaBundleLimitError(
          `${fileName}: preset JSON expands beyond the 8 MiB total limit`,
        );
      }
      if (data.byteLength) chunks.push(data.slice());
      if (final && memberBytes) {
        members.push({ data: joinChunks(chunks, memberBytes), name: member.name });
      }
    };
    member.start();
  });
  unzipper.register(UnzipInflate);

  if (!bytes.byteLength) {
    unzipper.push(bytes, true);
  } else {
    for (let offset = 0; offset < bytes.byteLength; offset += ZIP_INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + ZIP_INPUT_CHUNK_BYTES, bytes.byteLength);
      unzipper.push(bytes.subarray(offset, end), end === bytes.byteLength);
    }
  }
  return members;
}

/** Parse a single JSON preset. Returns an entry, or null with a reason. */
export function readOrcaPresetFile(source: string, text: string): OrcaImportResult {
  const preset = parseOrcaPreset(text);
  if (!preset) {
    return { entries: [], errors: [`${source}: not a recognisable OrcaSlicer preset`] };
  }
  return { entries: [{ source, preset, raw: text }], errors: [] };
}

/** Unpack a zipped bundle into its constituent preset entries. */
export function readOrcaBundle(fileName: string, bytes: Uint8Array): OrcaImportResult {
  const compressedSizeError = orcaBundleCompressedSizeError(fileName, bytes.byteLength);
  if (compressedSizeError) return { entries: [], errors: [compressedSizeError] };

  let members: Array<{ data: Uint8Array; name: string }>;
  try {
    members = extractPresetMembers(fileName, bytes);
  } catch (error) {
    if (error instanceof OrcaBundleLimitError) {
      return { entries: [], errors: [error.message] };
    }
    return { entries: [], errors: [`${fileName}: could not be read as a zip bundle`] };
  }

  const entries: OrcaImportEntry[] = [];
  const errors: string[] = [];
  for (const { data, name: memberName } of members) {
    if (!memberName.toLowerCase().endsWith(".json") || data.length === 0) continue;
    // Skip the bundle manifest OrcaSlicer writes alongside the presets — it's
    // metadata (bundle_type, per-type file lists), not a preset, and would
    // otherwise be reported as an unrecognised file.
    if (basename(memberName).toLowerCase() === "bundle_structure.json") continue;
    const result = readOrcaPresetFile(`${fileName}:${memberName}`, strFromU8(data));
    entries.push(...result.entries);
    errors.push(...result.errors);
  }

  if (!entries.length && !errors.length) {
    errors.push(`${fileName}: no preset JSON found in bundle`);
  }
  return { entries, errors };
}

/**
 * Dispatch an imported file by name: zipped bundles are unpacked, everything
 * else is treated as a single JSON preset. `bytes` is required for bundles;
 * `text` is used for plain presets (pass both — the caller already has them).
 */
export function readOrcaImport(name: string, bytes: Uint8Array, text: string): OrcaImportResult {
  return isBundleName(name) ? readOrcaBundle(name, bytes) : readOrcaPresetFile(name, text);
}
