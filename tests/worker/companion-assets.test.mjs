import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import {
  SESSION_TOKEN,
  WORKER_ORIGIN,
  bootSharedWorker,
  createCompanionAsset,
  db,
  dispatch,
  disposeSharedWorker,
  insertPrivatePackage,
} from "./helpers.mjs";

describe("worker API smoke: companion-assets", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("stores private companion assets behind authentication", async () => {
    const created = await dispatch("/api/companion-assets", {
      body: JSON.stringify({
        asset: {
          content: '{"type":"machine","name":"Bench Orca","machine_start_gcode":"START_PRINT"}',
          description: "Orca machine preset used with the bench printer.",
          kind: "machine",
          tags: ["orca", "machine"],
          title: "Bench Orca start gcode",
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const createdBody = await created.json();

    assert.equal(created.status, 201);
    assert.equal(createdBody.asset.kind, "machine");
    assert.equal(createdBody.asset.public, false);
    assert.equal(createdBody.asset.title, "Bench Orca start gcode");
    assert.equal(createdBody.asset.version, "1");

    const listed = await dispatch("/api/companion-assets", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const listedBody = await listed.json();

    assert.equal(listed.status, 200);
    assert.equal(listedBody.assets.some((asset) => asset.id === createdBody.asset.id), true);
  });

  it("hydrates private package companion links without leaking unpublished assets publicly", async () => {
    const asset = await createCompanionAsset("filament");
    await insertPrivatePackage("companion-package", [
      {
        content: "[printer]\nkinematics: cartesian\n",
        path: "printer.cfg",
        public: false,
        role: "printer",
      },
    ], [], [], [asset.id]);

    const privateResponse = await dispatch("/api/private-packages/companion-package", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const privateBody = await privateResponse.json();

    assert.equal(privateResponse.status, 200);
    assert.equal(privateBody.package.companionAssets.length, 1);
    assert.equal(privateBody.package.companionAssets[0].id, asset.id);
    assert.equal(privateBody.package.companionAssets[0].kind, "filament");

    const publishedPackage = await dispatch("/api/public-packages", {
      body: JSON.stringify({ packageId: "companion-package" }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const publishedPackageBody = await publishedPackage.json();
    assert.equal(publishedPackage.status, 201);

    const publicBeforeAsset = await dispatch(`/api/packages/${publishedPackageBody.slug}`);
    const publicBeforeAssetBody = await publicBeforeAsset.json();
    assert.equal(publicBeforeAsset.status, 200);
    assert.deepEqual(publicBeforeAssetBody.package.companionAssets, []);

    const publishedAsset = await dispatch(`/api/companion-assets/${asset.id}/publish`, {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const publishedAssetBody = await publishedAsset.json();
    assert.equal(publishedAsset.status, 201);
    assert.match(publishedAssetBody.shareUrl, /^https:\/\/klippee\.test\/assets\//);

    // The advertised share link must resolve to the SPA's public asset route:
    // a single-segment /assets/:slug path that App.tsx actually serves.
    const shareUrlPath = new URL(publishedAssetBody.shareUrl).pathname;
    assert.match(shareUrlPath, /^\/assets\/[^/]+$/);
    assert.equal(shareUrlPath, `/assets/${publishedAssetBody.slug}`);
    assert.equal(publishedAssetBody.sharePath, shareUrlPath);
    const appSource = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
    assert.equal(
      appSource.includes('path="/assets/:slug"'),
      true,
      "src/App.tsx must serve the /assets/:slug route that companion-asset share links advertise",
    );

    const publicAsset = await dispatch(`/api/public-companion-assets/${publishedAssetBody.slug}`);
    const publicAssetBody = await publicAsset.json();
    assert.equal(publicAsset.status, 200);
    assert.equal(publicAssetBody.asset.id, asset.id);
    assert.equal(publicAssetBody.asset.public, true);

    const publicAfterAsset = await dispatch(`/api/packages/${publishedPackageBody.slug}`);
    const publicAfterAssetBody = await publicAfterAsset.json();
    assert.equal(publicAfterAsset.status, 200);
    assert.equal(publicAfterAssetBody.package.companionAssets.length, 1);
    assert.equal(publicAfterAssetBody.package.companionAssets[0].publicUrl, publishedAssetBody.shareUrl);
  });

  it("only attaches public companion assets owned by the package publisher", async () => {
    const sharedAssetId = "tenant-scoped-companion-fixture";
    const ownerContent = '{"type":"filament","name":"owner preset","nozzle_temperature":["215"]}';
    const savedOwnerAsset = await dispatch("/api/companion-assets", {
      body: JSON.stringify({
        asset: {
          content: ownerContent,
          description: "Owner-only filament preset",
          id: sharedAssetId,
          kind: "filament",
          tags: ["owner"],
          title: "Owner filament preset",
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(savedOwnerAsset.status, 201);

    const timestamp = new Date().toISOString();
    const attackerAsset = {
      content: '{"type":"filament","name":"attacker preset","nozzle_temperature":["999"]}',
      createdAt: timestamp,
      description: "Cross-tenant fixture",
      id: sharedAssetId,
      kind: "filament",
      public: true,
      tags: ["attacker"],
      title: "Attacker filament preset",
      updatedAt: timestamp,
      version: "1",
    };
    await db.prepare(
      `INSERT INTO public_companion_assets
         (id, user_id, source_asset_id, slug, kind, title, asset_json, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "public-attacker-companion-fixture",
      "user_2",
      sharedAssetId,
      "attacker-tenant-scoped-companion-fixture",
      "filament",
      attackerAsset.title,
      JSON.stringify(attackerAsset),
      timestamp,
      timestamp,
      timestamp,
    ).run();

    await insertPrivatePackage("tenant-scoped-companion-package", [{
      content: "[printer]\nkinematics: cartesian\n",
      path: "printer.cfg",
      public: false,
      role: "printer",
    }], [], [], [sharedAssetId]);
    const publishedPackage = await dispatch("/api/public-packages", {
      body: JSON.stringify({ packageId: "tenant-scoped-companion-package" }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const publishedPackageBody = await publishedPackage.json();
    assert.equal(publishedPackage.status, 201);

    const beforeOwnerPublish = await dispatch(`/api/packages/${publishedPackageBody.slug}`);
    const beforeOwnerPublishBody = await beforeOwnerPublish.json();
    assert.equal(beforeOwnerPublish.status, 200);
    assert.deepEqual(beforeOwnerPublishBody.package.companionAssets, []);

    const ownerPublish = await dispatch(`/api/companion-assets/${sharedAssetId}/publish`, {
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const ownerPublishBody = await ownerPublish.json();
    assert.equal(ownerPublish.status, 201);

    const afterOwnerPublish = await dispatch(`/api/packages/${publishedPackageBody.slug}`);
    const afterOwnerPublishBody = await afterOwnerPublish.json();
    assert.equal(afterOwnerPublish.status, 200);
    assert.equal(afterOwnerPublishBody.package.companionAssets.length, 1);
    assert.equal(afterOwnerPublishBody.package.companionAssets[0].title, "Owner filament preset");
    assert.equal(afterOwnerPublishBody.package.companionAssets[0].content, ownerContent);
    assert.equal(afterOwnerPublishBody.package.companionAssets[0].publicUrl, ownerPublishBody.shareUrl);
  });
});
