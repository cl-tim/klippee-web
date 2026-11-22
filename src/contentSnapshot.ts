/** Compact repeated long strings inside the single JSON app-state value. */

export const contentSnapshotStorageFormat = "content-addressed-v1" as const;
export const contentSnapshotMaxBytes = 512_000;
const referenceKey = "$klippeeContentRef";
const escapeKey = "$klippeeEscapedObject";
const minimumContentBytes = 256;
const maximumDepth = 48;
const maximumNodes = 50_000;

type ContentSnapshot = {
  blobs: Record<string, string>;
  state: unknown;
  storageFormat: typeof contentSnapshotStorageFormat;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isMarkerObject(value: Record<string, unknown>) {
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === referenceKey || keys[0] === escapeKey);
}

export function isContentSnapshotEnvelope(value: unknown): value is ContentSnapshot {
  if (!isRecord(value)) return false;
  return value.storageFormat === contentSnapshotStorageFormat
    && Object.keys(value).length === 3
    && Object.prototype.hasOwnProperty.call(value, "blobs")
    && Object.prototype.hasOwnProperty.call(value, "state");
}

async function hashText(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function encodeContentSnapshot(state: unknown): Promise<ContentSnapshot> {
  const blobs: Record<string, string> = {};
  const hashByContent = new Map<string, Promise<string>>();
  let nodes = 0;
  // Keep the semantics of the JSON state_json column (omit undefined object
  // fields, turn undefined array entries and non-finite numbers into null).
  const jsonState = JSON.parse(JSON.stringify(state)) as unknown;
  if (byteLength(jsonState) > contentSnapshotMaxBytes) throw new Error("Cloud state is too large to store");

  async function encode(value: unknown, depth: number): Promise<unknown> {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) throw new Error("Cloud state is too complex to store");
    if (typeof value === "string" && new TextEncoder().encode(value).byteLength >= minimumContentBytes) {
      let hash = hashByContent.get(value);
      if (!hash) {
        hash = hashText(value);
        hashByContent.set(value, hash);
      }
      const sha256 = await hash;
      blobs[sha256] = value;
      return { [referenceKey]: sha256 };
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry) => encode(entry, depth + 1)));
    if (isRecord(value)) {
      const pairs = await Promise.all(Object.entries(value).map(async ([key, entry]) => [
        key,
        await encode(entry, depth + 1),
      ] as const));
      // Escape input objects that could otherwise be mistaken for codec nodes.
      return isMarkerObject(value) ? { [escapeKey]: pairs } : Object.fromEntries(pairs);
    }
    return value;
  }

  const snapshot: ContentSnapshot = {
    blobs,
    state: await encode(jsonState, 0),
    storageFormat: contentSnapshotStorageFormat,
  };
  if (byteLength(snapshot) > contentSnapshotMaxBytes) throw new Error("Cloud state is too large to store");
  return snapshot;
}

export async function decodeContentSnapshot(value: unknown): Promise<unknown | null> {
  if (!isContentSnapshotEnvelope(value) || !isRecord(value.blobs)) return null;
  const snapshot = value;
  if (byteLength(snapshot) > contentSnapshotMaxBytes) return null;
  const hashes = Object.keys(snapshot.blobs);
  if (hashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash) || typeof snapshot.blobs[hash] !== "string")) return null;
  const verified = await Promise.all(hashes.map(async (hash) => await hashText(snapshot.blobs[hash]) === hash));
  if (verified.some((valid) => !valid)) return null;

  let nodes = 0;
  const invalid = Symbol("invalid-content-snapshot");
  const jsonSizeByString = new Map<string, number>();
  function jsonSizeOfString(value: string) {
    let size = jsonSizeByString.get(value);
    if (size === undefined) {
      size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      jsonSizeByString.set(value, size);
    }
    return size;
  }
  type Decoded = { bytes: number; value: unknown };
  async function decode(entry: unknown, depth: number): Promise<Decoded | typeof invalid> {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) return invalid;
    if (Array.isArray(entry)) {
      const decoded: unknown[] = [];
      let bytes = 2;
      for (const child of entry) {
        const result = await decode(child, depth + 1);
        if (result === invalid) return invalid;
        bytes += result.bytes + (decoded.length > 0 ? 1 : 0);
        if (bytes > contentSnapshotMaxBytes) return invalid;
        decoded.push(result.value);
      }
      return { bytes, value: decoded };
    }
    if (!isRecord(entry)) {
      const serialized = JSON.stringify(entry);
      if (serialized === undefined) return invalid;
      const bytes = new TextEncoder().encode(serialized).byteLength;
      return bytes > contentSnapshotMaxBytes ? invalid : { bytes, value: entry };
    }
    const keys = Object.keys(entry);
    if (keys.length === 1 && Object.prototype.hasOwnProperty.call(entry, referenceKey)) {
      const hash = entry[referenceKey];
      if (typeof hash !== "string" || !Object.prototype.hasOwnProperty.call(snapshot.blobs, hash)) return invalid;
      const body = snapshot.blobs[hash];
      const bytes = jsonSizeOfString(body);
      return bytes > contentSnapshotMaxBytes ? invalid : { bytes, value: body };
    }
    if (keys.length === 1 && Object.prototype.hasOwnProperty.call(entry, escapeKey)) {
      const escapedPairs = entry[escapeKey];
      if (!Array.isArray(escapedPairs)) return invalid;
      return decodeObjectPairs(escapedPairs, depth);
    }
    return decodeObjectPairs(Object.entries(entry), depth);

    async function decodeObjectPairs(pairs: unknown[], pairDepth: number): Promise<Decoded | typeof invalid> {
      const decodedPairs: Array<[string, unknown]> = [];
      let bytes = 2;
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") return invalid;
        const child = await decode(pair[1], pairDepth + 1);
        if (child === invalid) return invalid;
        const separatorBytes = decodedPairs.length > 0 ? 1 : 0;
        bytes += separatorBytes + jsonSizeOfString(pair[0]) + 1 + child.bytes;
        if (bytes > contentSnapshotMaxBytes) return invalid;
        decodedPairs.push([pair[0], child.value]);
      }
      return { bytes, value: Object.fromEntries(decodedPairs) };
    }
  }

  const state = await decode(snapshot.state, 0);
  return state === invalid ? null : state.value;
}
