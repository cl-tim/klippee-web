import { describe, expect, it } from "vitest";
import { isGzipBytes, isZipBytes, safeUploadFileName, uploadObjectRows } from "./uploadLifecycle";

function buffer(...bytes: number[]) {
  return new Uint8Array(bytes).buffer;
}

describe("isGzipBytes", () => {
  it("accepts the gzip magic prefix", () => {
    expect(isGzipBytes(buffer(0x1f, 0x8b, 0x08, 0x00))).toBe(true);
  });

  it("rejects buffers shorter than the magic", () => {
    expect(isGzipBytes(buffer(0x1f))).toBe(false);
    expect(isGzipBytes(buffer())).toBe(false);
  });

  it("rejects other magic bytes", () => {
    expect(isGzipBytes(buffer(0x50, 0x4b, 0x03, 0x04))).toBe(false);
  });
});

describe("isZipBytes", () => {
  it.each([
    ["local file header", [0x50, 0x4b, 0x03, 0x04]],
    ["empty archive", [0x50, 0x4b, 0x05, 0x06]],
    ["spanned archive", [0x50, 0x4b, 0x07, 0x08]],
  ])("accepts a %s", (_label, bytes) => {
    expect(isZipBytes(buffer(...bytes))).toBe(true);
  });

  it("rejects short buffers and non-ZIP signatures", () => {
    expect(isZipBytes(buffer(0x50, 0x4b))).toBe(false);
    expect(isZipBytes(buffer(0x50, 0x4b, 0x01, 0x02))).toBe(false);
    expect(isZipBytes(buffer(0x1f, 0x8b, 0x08, 0x00))).toBe(false);
  });
});

describe("safeUploadFileName", () => {
  const gzOpts = { allowedExtensions: /\.(?:gz|log|txt)$/i, fallback: "klippy.log" };

  it("falls back when the header is absent", () => {
    expect(safeUploadFileName(null, gzOpts)).toBe("klippy.log");
  });

  it("keeps a clean matching name", () => {
    expect(safeUploadFileName("klippy.log.gz", gzOpts)).toBe("klippy.log.gz");
  });

  it("strips directory components including backslashes", () => {
    expect(safeUploadFileName("/var/log/klippy.log", gzOpts)).toBe("klippy.log");
    expect(safeUploadFileName("C:\\logs\\klippy.log", gzOpts)).toBe("klippy.log");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(safeUploadFileName("my log (1).txt", gzOpts)).toBe("my_log__1_.txt");
  });

  it("falls back when the extension is not allowed", () => {
    expect(safeUploadFileName("payload.exe", gzOpts)).toBe("klippy.log");
  });

  it("caps the cleaned name at 120 characters", () => {
    const name = `${"a".repeat(200)}.log`;
    expect(safeUploadFileName(name, gzOpts)).toBe("klippy.log");
    const kept = safeUploadFileName(`${"a".repeat(116)}.log`, gzOpts);
    expect(kept).toBe(`${"a".repeat(116)}.log`);
    expect(kept).toHaveLength(120);
  });

  it("decodes URI-encoded names only when asked", () => {
    expect(safeUploadFileName("klippy%20log.txt", { ...gzOpts, decodeUri: true })).toBe("klippy_log.txt");
    expect(safeUploadFileName("klippy%20log.txt", gzOpts)).toBe("klippy_20log.txt");
  });

  it("keeps the raw value when it is not valid URI encoding", () => {
    expect(safeUploadFileName("100%.log", { ...gzOpts, decodeUri: true })).toBe("100_.log");
  });
});

describe("uploadObjectRows", () => {
  it("keeps only rows with string id and r2_key", () => {
    expect(uploadObjectRows([
      { id: "a", r2_key: "k/a" },
      { id: 2, r2_key: "k/b" },
      { id: "c" },
      { id: "d", r2_key: null },
    ])).toEqual([{ id: "a", r2_key: "k/a" }]);
  });

  it("tolerates missing result sets", () => {
    expect(uploadObjectRows(undefined)).toEqual([]);
  });
});
