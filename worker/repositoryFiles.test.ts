import { describe, expect, it } from "vitest";
import { loadRepositoryFiles, type RepositoryBlobCache } from "./repositoryFiles";
import type { Env } from "./types";
import { sha256Hex } from "./util";

describe("repository file loading", () => {
  it("reads a shared content-addressed body once across manifests in a request", async () => {
    const content = "[printer]\nkinematics: corexy\n";
    const sha256 = await sha256Hex(content);
    let reads = 0;
    const env = {
      BLOBS: {
        get: async (key: string) => {
          reads += 1;
          expect(key).toBe(`blobs/sha256/${sha256}`);
          return { text: async () => content };
        },
      },
    } as unknown as Env;
    const cache: RepositoryBlobCache = new Map();
    const manifest = (path: string) => JSON.stringify({
      entries: [{ byteLength: new TextEncoder().encode(content).byteLength, path, public: false, role: "printer", sha256 }],
      storage: "r2-blobs",
      version: 2,
    });

    const [versionOne, versionTwo] = await Promise.all([
      loadRepositoryFiles(env, manifest("printer.cfg"), cache),
      loadRepositoryFiles(env, manifest("backup.cfg"), cache),
    ]);

    expect(reads).toBe(1);
    expect(versionOne?.[0]).toEqual({ content, path: "printer.cfg", public: false, role: "printer" });
    expect(versionTwo?.[0]).toEqual({ content, path: "backup.cfg", public: false, role: "printer" });
  });
});
