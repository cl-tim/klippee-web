import assert from "node:assert/strict";
import { it } from "node:test";
import { createWorkerMiniflare, WORKER_ORIGIN } from "./helpers.mjs";

it("permanently redirects legacy catalog links and preserves query strings", async () => {
  const assetPaths = [];
  const mf = createWorkerMiniflare({
    serviceBindings: {
      ASSETS: (request) => {
        assetPaths.push(new URL(request.url).pathname);
        return new Response("<!doctype html><div id='root'></div>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  });
  try {
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/registry", "/registry/", "/registry?type=orca", "/registry/?tag=voron%20build&tag=corexy"]) {
        const response = await mf.dispatchFetch(`${WORKER_ORIGIN}${path}`, { method, redirect: "manual" });
        assert.equal(response.status, 308);
        assert.equal(response.headers.get("location"), `${WORKER_ORIGIN}/shared-configs${new URL(path, WORKER_ORIGIN).search}`);
        assert.equal(await response.text(), "");
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      }
    }
    assert.deepEqual(assetPaths, [], "Redirects must run before the SPA asset handler");

    for (const path of ["/shared-configs", "/shared-configs?type=orca", "/registry-other"]) {
      const response = await mf.dispatchFetch(`${WORKER_ORIGIN}${path}`, { redirect: "manual" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.has("location"), false);
      assert.match(await response.text(), /id='root'/);
    }
    assert.deepEqual(assetPaths, ["/shared-configs", "/shared-configs", "/registry-other"]);
  } finally {
    await mf.dispose();
  }
});
