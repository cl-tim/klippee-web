import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  SESSION_TOKEN,
  WORKER_ORIGIN,
  bootSharedWorker,
  db,
  dispatch,
  disposeSharedWorker,
  mf,
} from "./helpers.mjs";

describe("worker API smoke: packages-private", () => {
  before(async () => {
    await bootSharedWorker();
  });

  after(async () => {
    await disposeSharedWorker();
  });

  it("publishes the stored private package by id instead of trusting submitted package data", async () => {
    const response = await dispatch("/api/public-packages", {
      body: JSON.stringify({
        package: {
          id: "package_1",
          title: "Tampered title",
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.package.id, body.slug);
    assert.equal(body.package.publicSlug, body.slug);
    assert.equal(body.package.sourcePackageId, "package_1");
    assert.equal(body.package.title, "Stored package");
    assert.equal(body.package.files.every((file) => file.public), true);
    assert.match(body.shareUrl, /^https:\/\/klippee\.test\/packages\//);
  });

  it("offloads private package bodies to content-addressed blobs", async () => {
    const save = await dispatch("/api/private-packages", {
      body: JSON.stringify({
        package: {
          description: "Offload test",
          files: [{ content: "[printer]\nkinematics: cartesian\n", path: "printer.cfg", public: false, role: "printer" }],
          hardware: ["cartesian"],
          id: "offload-package",
          name: "offload-package",
          printer: "Bench printer",
          tags: ["private"],
          title: "Offload package",
          variables: [],
          version: "2026.05.22",
          warnings: [],
        },
      }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    assert.equal(save.status, 201);

    // D1 stores only metadata + a manifest pointer, not inline file contents.
    const row = await db.prepare("SELECT package_json FROM private_packages WHERE user_id = ? AND package_id = ?")
      .bind("user_1", "offload-package")
      .first();
    const stored = JSON.parse(row.package_json);
    assert.equal(stored.bodyStorage, "r2-blobs");
    assert.equal("files" in stored, false);
    assert.equal(typeof stored.filesManifest, "string");

    const manifest = JSON.parse(stored.filesManifest);
    const bucket = await mf.getR2Bucket("BLOBS");
    assert.notEqual(await bucket.head(`blobs/sha256/${manifest.entries[0].sha256}`), null);

    // Listing returns a summary with file metadata but no blob-backed contents.
    const list = await dispatch("/api/private-packages", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const listBody = await list.json();
    const found = listBody.packages.find((pkg) => pkg.id === "offload-package");
    assert.equal(found.files.find((file) => file.path === "printer.cfg").content, "");

    // Opening a private package by id hydrates full file contents from R2.
    const full = await dispatch("/api/private-packages/offload-package", {
      headers: { cookie: `__Host-klippee_session=${SESSION_TOKEN}` },
    });
    const fullBody = await full.json();
    assert.equal(full.status, 200);
    assert.equal(
      fullBody.package.files.find((file) => file.path === "printer.cfg").content,
      "[printer]\nkinematics: cartesian\n",
    );
  });

  it("requires a package id when publishing", async () => {
    const response = await dispatch("/api/public-packages", {
      body: JSON.stringify({ package: { title: "Missing id" } }),
      headers: {
        cookie: `__Host-klippee_session=${SESSION_TOKEN}`,
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
      },
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Package id is required" });
  });
});
