import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import {
  buildPublicListingMetadataUpdateStatements,
  createPublicPackagePublishPlan,
  createPublicPackageRowId,
  createPublicPackageSlug,
} from "../worker/packagePublishing";
import type { D1Client } from "../worker/types";
import type { ConfigPackage } from "./types";

const pkg: ConfigPackage = {
  description: "Voron starter package",
  files: [
    {
      content: "[include macros.cfg]\n",
      path: "printer.cfg",
      role: "printer",
    },
  ],
  hardware: ["Stealthburner"],
  id: "pkg-1",
  name: "Voron Starter",
  printer: "Voron 2.4",
  tags: ["Klipper", "CoreXY"],
  title: "Voron Starter",
  variables: [],
  version: "1.0.0",
  warnings: [],
};

describe("createPublicPackagePublishPlan", () => {
  it("builds public package identity, search facets, and the share response from a unique slug", () => {
    const plan = createPublicPackagePublishPlan({
      createdAt: "2026-05-24T11:00:00.000Z",
      origin: "https://klippee.xyz",
      pkg,
      rowId: "row-id",
      slug: "voron-starter-1-0-0-0123456789abcdef",
      timestamp: "2026-05-24T12:00:00.000Z",
      userId: "user-id",
    });

    expect(plan.row).toMatchObject({
      id: "row-id",
      name: "Voron Starter",
      printer_facet: "voron 2.4",
      slug: "voron-starter-1-0-0-0123456789abcdef",
      source_package_id: "pkg-1",
      tags_facet: "|klipper|corexy|",
      user_id: "user-id",
    });
    expect(plan.row.search_text).toContain("voron starter");
    expect(plan.response).toMatchObject({
      package: {
        id: "voron-starter-1-0-0-0123456789abcdef",
        publicCreatedAt: "2026-05-24T11:00:00.000Z",
        publicSlug: "voron-starter-1-0-0-0123456789abcdef",
        sourcePackageId: "pkg-1",
      },
      publishedAt: "2026-05-24T12:00:00.000Z",
      sharePath: "/packages/voron-starter-1-0-0-0123456789abcdef",
      shareUrl: "https://klippee.xyz/packages/voron-starter-1-0-0-0123456789abcdef",
      slug: "voron-starter-1-0-0-0123456789abcdef",
    });
  });

  it("creates stable package slugs that differ between owners", async () => {
    const first = await createPublicPackageSlug(pkg, "user-one");
    const repeated = await createPublicPackageSlug(pkg, "user-one");
    const otherOwner = await createPublicPackageSlug(pkg, "user-two");

    expect(first).toBe(repeated);
    expect(first).toMatch(/^voron-starter-1-0-0-[a-f0-9]{24}$/);
    expect(otherOwner).toMatch(/^voron-starter-1-0-0-[a-f0-9]{24}$/);
    expect(otherOwner).not.toBe(first);
  });

  it("keeps the database row identity stable when slug metadata changes", async () => {
    const renamed = {
      ...pkg,
      name: "Renamed Voron Starter",
      version: "2.0.0",
    };
    const firstRowId = await createPublicPackageRowId("user-one", pkg.id);
    const renamedRowId = await createPublicPackageRowId("user-one", renamed.id);
    const otherOwnerRowId = await createPublicPackageRowId("user-two", pkg.id);

    expect(firstRowId).toBe(renamedRowId);
    expect(firstRowId).toMatch(/^publication-[a-f0-9]{24}$/);
    expect(otherOwnerRowId).not.toBe(firstRowId);
    expect(await createPublicPackageSlug(renamed, "user-one"))
      .not.toBe(await createPublicPackageSlug(pkg, "user-one"));
  });
});

describe("public listing metadata compare-and-swap", () => {
  it("does not overwrite a concurrent republish or its private source edit", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE public_packages (
        id TEXT, user_id TEXT, source_package_id TEXT, repository_id TEXT, printer_id TEXT,
        approved_version_id TEXT, package_json TEXT, title TEXT, printer_facet TEXT,
        tags_facet TEXT, search_text TEXT, updated_at TEXT
      );
      CREATE TABLE private_packages (
        user_id TEXT, package_id TEXT, package_json TEXT, title TEXT, updated_at TEXT
      );
    `);
    sqlite.prepare("INSERT INTO public_packages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "publication", "user", "source", "repo", "printer", "version-1",
      "public-old", "Old title", "", "", "", "t1",
    );
    sqlite.prepare("INSERT INTO private_packages VALUES (?,?,?,?,?)").run(
      "user", "source", "private-old", "Old title", "t1",
    );

    const fakeD1: D1Client = {
      prepare() { throw new Error("Query construction must not prepare D1 statements"); },
      batch() { throw new Error("Query construction must not execute D1"); },
    };
    const statements = buildPublicListingMetadataUpdateStatements(fakeD1, {
      expectedPrivate: { packageJson: "private-old", updatedAt: "t1" },
      expectedPublic: {
        approvedVersionId: "version-1",
        id: "publication",
        packageJson: "public-old",
        printerId: "printer",
        repositoryId: "repo",
        updatedAt: "t1",
      },
      privatePackageJson: "private-with-old-files-and-new-title",
      privateTitle: "Edited title",
      publicPackageJson: "public-with-old-files-and-new-title",
      publicSearch: { printerFacet: "", searchText: "", tagsFacet: "" },
      sourcePackageId: "source",
      timestamp: "t3",
      title: "Edited title",
      userId: "user",
    });

    // A republish and a concurrent private edit commit while the PATCH is
    // loading/storing its candidate blobs, before its guarded write batch.
    sqlite.prepare(
      "UPDATE public_packages SET approved_version_id=?, package_json=?, updated_at=? WHERE id=?",
    ).run("version-2", "public-new", "t2", "publication");
    sqlite.prepare(
      "UPDATE private_packages SET package_json=?, updated_at=? WHERE user_id=? AND package_id=?",
    ).run("private-new", "t2", "user", "source");

    for (const statement of statements) {
      const query = statement.toSQL();
      const values = query.params.map(value => {
        if (typeof value === "string" || typeof value === "number" || value === null) return value;
        throw new Error("Unexpected SQL parameter type");
      });
      sqlite.prepare(query.sql).run(...values);
    }

    expect(sqlite.prepare(
      "SELECT approved_version_id, package_json FROM public_packages WHERE id=?",
    ).get("publication")).toEqual({ approved_version_id: "version-2", package_json: "public-new" });
    expect(sqlite.prepare(
      "SELECT package_json FROM private_packages WHERE user_id=? AND package_id=?",
    ).get("user", "source")).toEqual({ package_json: "private-new" });
    sqlite.close();
  });
});
