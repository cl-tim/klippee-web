import { describe, expect, it } from "vitest";
import { distinctBlobClaims, validateBlobState, type BlobStateRow } from "./blobBudget";
import { canonicalBlobMinimumChargeBytes } from "./storageLimits";

describe("distinctBlobClaims", () => {
  it("returns an empty list for no claims", () => {
    expect(distinctBlobClaims([])).toEqual([]);
  });

  it("applies the minimum charge floor to small blobs", () => {
    const [claim] = distinctBlobClaims([{ sha256: "a".repeat(64), sizeBytes: 10 }]);
    expect(claim.sizeBytes).toBe(10);
    expect(claim.chargeBytes).toBe(canonicalBlobMinimumChargeBytes);
  });

  it("charges the actual size once it exceeds the floor", () => {
    const size = canonicalBlobMinimumChargeBytes + 1;
    const [claim] = distinctBlobClaims([{ sha256: "b".repeat(64), sizeBytes: size }]);
    expect(claim.chargeBytes).toBe(size);
  });

  it("charges exactly the floor at the boundary", () => {
    const [claim] = distinctBlobClaims([
      { sha256: "c".repeat(64), sizeBytes: canonicalBlobMinimumChargeBytes },
    ]);
    expect(claim.chargeBytes).toBe(canonicalBlobMinimumChargeBytes);
  });

  it("deduplicates by hash with the last occurrence winning", () => {
    const hash = "d".repeat(64);
    const claims = distinctBlobClaims([
      { sha256: hash, sizeBytes: 100 },
      { sha256: "e".repeat(64), sizeBytes: 200 },
      { sha256: hash, sizeBytes: 300 },
    ]);
    expect(claims).toHaveLength(2);
    expect(claims.find((claim) => claim.sha256 === hash)?.sizeBytes).toBe(300);
  });
});

describe("validateBlobState", () => {
  const hash = "f".repeat(64);
  const claims = distinctBlobClaims([{ sha256: hash, sizeBytes: 512 }]);

  function row(overrides: Partial<BlobStateRow> = {}): BlobStateRow {
    return {
      service_size: 512,
      sha256: hash,
      stored_at: null,
      user_size: 512,
      ...overrides,
    };
  }

  it("accepts matching ledger state", () => {
    expect(() => validateBlobState([row()], claims)).not.toThrow();
  });

  it("throws when the row count does not match the claim count", () => {
    expect(() => validateBlobState([], claims)).toThrow("incomplete state");
  });

  it("throws when a row belongs to an unrequested hash", () => {
    expect(() => validateBlobState([row({ sha256: "0".repeat(64) })], claims))
      .toThrow("size invariant");
  });

  it("throws when the user claim size disagrees", () => {
    expect(() => validateBlobState([row({ user_size: 511 })], claims)).toThrow("size invariant");
  });

  it("throws when the canonical blob size disagrees", () => {
    expect(() => validateBlobState([row({ service_size: 1_024 })], claims)).toThrow("size invariant");
  });

  it("throws when ledger rows are missing entirely (null sizes)", () => {
    expect(() => validateBlobState([row({ service_size: null, user_size: null })], claims))
      .toThrow("size invariant");
  });
});
