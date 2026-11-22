import assert from "node:assert/strict";
import { it } from "node:test";
import { createWorkerMiniflare, WORKER_ORIGIN } from "./helpers.mjs";

it("serves HTML with fresh Cloudflare-compatible CSP nonces through the Worker", async () => {
  const mf = createWorkerMiniflare({
    serviceBindings: {
      ASSETS: () => new Response("<!doctype html><div id='root'></div>", {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600", etag: "static-html" },
      }),
    },
  });
  try {
    const first = await mf.dispatchFetch(`${WORKER_ORIGIN}/`);
    const second = await mf.dispatchFetch(`${WORKER_ORIGIN}/shared-configs`);
    const policy = first.headers.get("content-security-policy");
    assert.match(policy, /script-src 'self' https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js 'nonce-[a-f0-9]{32}'/);
    assert.notEqual(policy, second.headers.get("content-security-policy"));
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(first.headers.has("etag"), false);
    assert.match(await first.text(), /id='root'/);
  } finally {
    await mf.dispose();
  }
});
