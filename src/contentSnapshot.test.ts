import { describe, expect, it } from "vitest";
import {
  contentSnapshotStorageFormat,
  decodeContentSnapshot,
  encodeContentSnapshot,
  isContentSnapshotEnvelope,
} from "./contentSnapshot";

describe("content snapshots", () => {
  it("round-trips arbitrary JSON while storing repeated Unicode content once", async () => {
    const repeated = "π workspace configuration\n".repeat(32);
    const state = JSON.parse('{"__proto__":{"safe":true},"$klippeeContentRef":"literal key","$klippeeEscapedObject":{"nested":1},"storageFormat":"user metadata"}');
    state.values = [null, true, 7, repeated, repeated];

    const encoded = await encodeContentSnapshot(state);

    expect(encoded.storageFormat).toBe(contentSnapshotStorageFormat);
    expect(Object.keys(encoded.blobs)).toHaveLength(1);
    expect(await decodeContentSnapshot(encoded)).toEqual(state);
  });

  it("rejects malformed references and snapshots that expand past the state bound", async () => {
    const malformed = {
      blobs: {},
      state: { $klippeeContentRef: "a".repeat(64) },
      storageFormat: contentSnapshotStorageFormat,
    };
    expect(await decodeContentSnapshot(malformed)).toBeNull();
    expect(isContentSnapshotEnvelope({ ...malformed, extra: true })).toBe(false);

    const largeBody = "x".repeat(300_000);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(largeBody));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const expanded = {
      blobs: { [hash]: largeBody },
      state: [
        { $klippeeContentRef: hash },
        { $klippeeContentRef: hash },
      ],
      storageFormat: contentSnapshotStorageFormat,
    };
    expect(await decodeContentSnapshot(expanded)).toBeNull();

    const shortBody = "y".repeat(260);
    const shortDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(shortBody));
    const shortHash = [...new Uint8Array(shortDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const repeatedReferences = {
      blobs: { [shortHash]: shortBody },
      state: Array.from({ length: 3_000 }, () => ({ $klippeeContentRef: shortHash })),
      storageFormat: contentSnapshotStorageFormat,
    };
    expect(JSON.stringify(repeatedReferences).length).toBeLessThan(512_000);
    expect(await decodeContentSnapshot(repeatedReferences)).toBeNull();
  });
});
