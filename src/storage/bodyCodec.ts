const nodeTag = "__klippeeStorageNode";

export type EncodedValue = unknown;
export type EncodedBodies = { bodies: Map<string, string>; value: EncodedValue };

function taggedNode(value: unknown, kind: string): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)[nodeTag] === kind);
}

export function encodedValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if ((index in left) !== (index in right)) return false;
      if (index in left && !encodedValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && encodedValuesEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

async function contentHash(text: string) {
  const bytes = new TextEncoder().encode(text);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isContentField(key: string, parentKey: string | null) {
  return key === "content" || key === "source" || key === "workspaceContent" || parentKey === "workspaceDrafts";
}

export async function encodeBodies(value: unknown, rootKey: string | null = null): Promise<EncodedBodies> {
  const bodies = new Map<string, string>();
  const hashes = new Map<string, Promise<string>>();
  function hash(text: string) {
    let pending = hashes.get(text);
    if (!pending) {
      pending = contentHash(text);
      hashes.set(text, pending);
    }
    return pending;
  }

  async function encode(current: unknown, key: string | null = null, parentKey: string | null = null): Promise<unknown> {
    if (typeof current === "string" && key && isContentField(key, parentKey)) {
      const digest = await hash(current);
      bodies.set(digest, current);
      return { [nodeTag]: "body", hash: digest };
    }
    if (Array.isArray(current)) {
      return { [nodeTag]: "array", values: await Promise.all(current.map((item) => encode(item, key, parentKey))) };
    }
    if (current && typeof current === "object") {
      const entries = await Promise.all(Object.entries(current).map(async ([childKey, child]) => [childKey, await encode(child, childKey, key)] as const));
      return { [nodeTag]: "object", entries };
    }
    return current;
  }
  return { bodies, value: await encode(value, rootKey) };
}

export function findBodyHashes(value: unknown, output: Set<string>) {
  if (taggedNode(value, "body")) {
    if (typeof value.hash === "string") output.add(value.hash);
  } else if (taggedNode(value, "array")) {
    if (Array.isArray(value.values)) for (const item of value.values) findBodyHashes(item, output);
  } else if (taggedNode(value, "object")) {
    if (Array.isArray(value.entries)) {
      for (const entry of value.entries) {
        if (Array.isArray(entry)) findBodyHashes(entry[1], output);
      }
    }
  }
}

export function decodeBodies(value: unknown, bodies: Map<string, string>): unknown {
  if (taggedNode(value, "body")) {
    const text = typeof value.hash === "string" ? bodies.get(value.hash) : undefined;
    if (text === undefined) throw new Error("A saved workspace file is missing from local browser storage. Its metadata was preserved; reload after restoring browser storage access.");
    return text;
  }
  if (taggedNode(value, "array")) {
    return Array.isArray(value.values) ? value.values.map((item) => decodeBodies(item, bodies)) : [];
  }
  if (taggedNode(value, "object")) {
    const entries = Array.isArray(value.entries) ? value.entries : [];
    return Object.fromEntries(entries.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string").map(([key, child]) => [key, decodeBodies(child, bodies)]));
  }
  return value;
}
