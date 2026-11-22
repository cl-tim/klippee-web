import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bootSharedWorker, db, dispatch, disposeSharedWorker, insertPrivatePackage } from "./helpers.mjs";

describe("Shared Configs catalog read contracts", () => {
  before(async () => {
    await bootSharedWorker();
    const base = JSON.parse((await db.prepare("SELECT package_json FROM private_packages LIMIT 1").first()).package_json);
    for (const [index, description] of [
      "100% under_score back\\slash one two three four five six seven eight",
      "100percent underXscore backslash",
    ].entries()) {
      const slug = `catalog-pilot-${index}`;
      const pkg = { ...base, id: slug, name: slug, title: slug, description,
        printer: "Pilot printer", tags: ["catalog-pilot", "literal_%\\tag"] };
      await db.prepare(`INSERT INTO public_packages
        (id,user_id,source_package_id,slug,name,title,package_json,printer_facet,tags_facet,search_text,created_at,updated_at,published_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(slug, index ? "user_2" : "user_1", slug, slug, slug, slug,
        JSON.stringify(pkg), "pilot printer", "|catalog-pilot|literal_%\\tag|",
        `${slug} ${description} pilot printer`.toLowerCase(), "2026-10-01", `2026-10-0${index + 1}`, "2026-10-01").run();
    }
    await insertPrivatePackage("unpublished-catalog-pilot", [{ path: "printer.cfg", content: "PRIVATE", public: false, role: "printer" }]);
    for (let index = 0; index < 27; index += 1) {
      const slug = `profile-${String(index).padStart(2, "0")}`;
      const kind = index === 26 ? "slicer" : ["machine", "filament", "process"][index % 3];
      const tags = index === 26 ? ["9.9 mm nozzle"] : index === 1 ? ["No nozzle restriction"]
        : index === 2 ? ["0.2 mm nozzle"] : ["0.4 mm nozzle", "invalid mm nozzle"];
      const title = index === 0 ? "Pilot TARGET 100%_\\ profile" : `Pilot profile ${index}`;
      const asset = { kind, title, description: "Public pilot profile", tags, version: "3", content: "OMITTED_FROM_SUMMARY" };
      await db.prepare(`INSERT INTO public_companion_assets
        (id,user_id,source_asset_id,slug,kind,title,asset_json,created_at,updated_at,published_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(slug, "user_1", slug, slug, kind, title, JSON.stringify(asset),
        "2026-10-01", "2026-10-01", "2026-10-01").run();
    }
    await db.prepare(`INSERT INTO companion_assets (id,user_id,kind,title,asset_json,created_at,updated_at)
      VALUES ('private-pilot','user_1','machine','Private pilot','{}','2026-10-01','2026-10-01')`).run();
  });
  after(disposeSharedWorker);

  async function get(path) {
    const response = await dispatch(path);
    assert.equal(response.status, 200);
    return response.json();
  }

  it("keeps literal package searches, exact facets, ordering and public snapshots", async () => {
    const slugs = async (query) => (await get(`/api/packages?${new URLSearchParams(query)}`)).packages.map(pkg => pkg.id);
    assert.deepEqual(await slugs({ tag: "CATALOG-PILOT", printer: "PILOT PRINTER" }), ["catalog-pilot-1", "catalog-pilot-0"]);
    assert.deepEqual(await slugs({ tag: "catalog-pilo" }), []);
    assert.deepEqual(await slugs({ tag: "literal_%\\tag" }), ["catalog-pilot-1", "catalog-pilot-0"]);
    for (const q of ["100%", "under_score", "back\\slash", "UNDER_SCORE 100%", "one two three four five six seven eight ignored-ninth-term"]) {
      assert.deepEqual(await slugs({ tag: "catalog-pilot", q }), ["catalog-pilot-0"]);
    }
    assert.deepEqual(await slugs({ q: "' OR 1=1 --" }), []);
    assert.deepEqual(await slugs({ q: "unpublished-catalog-pilot" }), []);
    const { packages } = await get("/api/packages?tag=catalog-pilot");
    assert.equal(packages.length, 2);
    for (const pkg of packages) {
      assert.equal(pkg.tracksAppliedConfiguration, false);
      assert(pkg.files.every(file => file.content === ""));
      assert.equal("user_id" in pkg, false);
    }
  });

  it("keeps deterministic Orca pagination and summary-only public results", async () => {
    const first = await get("/api/public-companion-assets");
    assert.equal(first.assets.length, 24);
    assert.equal(first.nextOffset, 24);
    assert.deepEqual(first.assets.map(asset => asset.publicSlug), Array.from({ length: 24 }, (_, i) => `profile-${String(i).padStart(2, "0")}`));
    const second = await get("/api/public-companion-assets?offset=24");
    assert.deepEqual(second.assets.map(asset => asset.publicSlug), ["profile-24", "profile-25"]);
    assert.equal(second.nextOffset, null);
    for (const asset of [...first.assets, ...second.assets]) {
      assert.equal("content" in asset, false);
      assert.equal("user_id" in asset, false);
      assert.equal(asset.version, "3");
      assert(Array.isArray(asset.tags));
    }
    assert.deepEqual(first.nozzleSizes, ["0.2", "0.4"]);
  });

  it("keeps Orca substring search, kind filters, unrestricted nozzles and filter validation", async () => {
    const filtered = await get(`/api/public-companion-assets?${new URLSearchParams({ kind: "machine", nozzle: "0.4", q: "  target 100%_\\  " })}`);
    assert.deepEqual(filtered.assets.map(asset => asset.publicSlug), ["profile-00"]);
    const unrestricted = await get("/api/public-companion-assets?nozzle=0.8");
    assert.deepEqual(unrestricted.assets.map(asset => asset.publicSlug), ["profile-01"]);
    assert.deepEqual(unrestricted.nozzleSizes, ["0.2", "0.4"]);
    assert.deepEqual((await get("/api/public-companion-assets?q=Private%20pilot")).assets, []);
    for (const query of ["offset=-1", "offset=1.5", "offset=100001", "kind=slicer", "nozzle=0.4%27%20OR%201=1"]) {
      const response = await dispatch(`/api/public-companion-assets?${query}`);
      assert.equal(response.status, 400);
    }
  });
});
