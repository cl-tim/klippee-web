import { describe, expect, it } from "vitest";
import {
  PackageRenderLimitError,
  PackageVariableInputError,
  removeExpiredRenderedZipArtifacts,
  renderPackageFiles,
  renderValuesForBody,
  unresolvedTemplateVariables,
} from "./packageRendering";
import type { ConfigPackage, PackageVariable } from "../src/types";
import type { Env } from "./types";

function configFile(path: string, content: string) {
  return { content, path, public: true, role: "printer" };
}

function packageFixture(files: ConfigPackage["files"], variables: PackageVariable[] = []): ConfigPackage {
  return {
    description: "Package rendering fixture",
    files,
    hardware: [],
    id: "rendering-fixture",
    name: "rendering-fixture",
    printer: "Test printer",
    tags: [],
    title: "Rendering fixture",
    variables,
    version: "1",
    warnings: [],
  };
}

describe("bounded package rendering", () => {
  it("preflights aggregate UTF-8 output across every file", () => {
    const files = [
      configFile("printer.cfg", "${KLIPPEE:value}"),
      configFile("macros.cfg", "${KLIPPEE:value}"),
    ];

    expect(renderPackageFiles(files, { value: "éé" }, 8).map((file) => file.content)).toEqual(["éé", "éé"]);
    expect(() => renderPackageFiles(files, { value: "éé" }, 7)).toThrow(PackageRenderLimitError);
  });

  it("rejects repeated-placeholder amplification before building expanded strings", () => {
    const files = [configFile("printer.cfg", "${KLIPPEE:value}".repeat(300))];

    expect(() => renderPackageFiles(files, { value: "x".repeat(1_000) }, 10_000)).toThrowError(
      "Rendered package exceeds the 10000-byte limit",
    );
  });

  it("does not resolve missing variable names through Object.prototype", () => {
    const content = "value: ${KLIPPEE:constructor}\n";
    const [rendered] = renderPackageFiles([configFile("printer.cfg", content)], {}, 1_000);

    expect(rendered.content).toBe(content);
    expect(unresolvedTemplateVariables(rendered.content)).toEqual(["constructor"]);
  });

  it("keeps only declared scalar request values", async () => {
    const allowedVariable: PackageVariable = {
      description: "Allowed render value",
      label: "Allowed",
      name: "allowed",
      required: false,
      secret: false,
      type: "string",
    };
    const pkg = packageFixture(
      [configFile("printer.cfg", "${KLIPPEE:allowed} ${KLIPPEE:undeclared_secret}")],
      [allowedVariable],
    );
    const request = new Request("https://klippee.test/api/render", { method: "POST" });
    const values = await renderValuesForBody(
      request,
      {} as Env,
      pkg,
      { variables: { allowed: "safe", undeclared_secret: "must-not-render" } },
      { allowSecrets: true },
    );

    expect(values).toEqual({ allowed: "safe" });
    expect(renderPackageFiles(pkg.files, values, 1_000)[0].content).toBe(
      "safe ${KLIPPEE:undeclared_secret}",
    );

    await expect(renderValuesForBody(
      request,
      {} as Env,
      pkg,
      { variables: { allowed: ["nested"] } },
      { allowSecrets: true },
    )).rejects.toBeInstanceOf(PackageVariableInputError);
  });
});

function renderedZipFixture(count: number) {
  const objects = new Map(Array.from({ length: count }, (_, index) => {
    const key = `artifacts/rendered-zips/sha256/expired-${String(index).padStart(4, "0")}.zip`;
    return [key, {
      checksums: {},
      customMetadata: { artifactType: "rendered-zip", expiresAt: "2000-01-01T00:00:00.000Z" },
      etag: `etag-${index}`,
      httpEtag: `"etag-${index}"`,
      key,
      size: 4,
      storageClass: "Standard",
      uploaded: new Date("1999-01-01T00:00:00.000Z"),
      version: `version-${index}`,
    }];
  }));

  const env = {
    BLOBS: {
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
      async list(options?: R2ListOptions) {
        const limit = options?.limit ?? 1_000;
        const listed = [...objects.values()].slice(0, limit);
        return {
          delimitedPrefixes: [],
          objects: listed,
          truncated: objects.size > listed.length,
          ...(objects.size > listed.length ? { cursor: "next" } : {}),
        };
      },
    } as unknown as R2Bucket,
  } as Env;

  return { env, remaining: () => objects.size };
}

describe("legacy rendered ZIP cleanup", () => {
  it("never deletes more than the configured per-run bound", async () => {
    const fixture = renderedZipFixture(699);

    expect(await removeExpiredRenderedZipArtifacts(
      fixture.env,
      "2026-08-05T00:00:00.000Z",
      500,
    )).toBe(500);
    expect(fixture.remaining()).toBe(199);

    expect(await removeExpiredRenderedZipArtifacts(
      fixture.env,
      "2026-08-05T00:00:00.000Z",
      500,
    )).toBe(199);
    expect(fixture.remaining()).toBe(0);
  });
});
