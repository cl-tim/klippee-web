import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerMiniflare } from "./helpers.mjs";

test("built Worker keeps production HTML policy even on localhost with local auth enabled", async () => {
  const html = '<!doctype html><script nonce="__KLIPPEE_VITE_NONCE__">marked()</script><script>unmarked()</script><div id="root"></div>';
  const worker = createWorkerMiniflare({
    serviceBindings: {
      ASSETS: () => new Response(html, { headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=3600",
        etag: "cached-html",
      } }),
    },
  });
  try {
    const nonces = [];
    for (const origin of ["https://klippee.test", "http://localhost:5173"]) {
      const response = await worker.dispatchFetch(`${origin}/`);
      assert.equal(response.status, 200);
      const policy = response.headers.get("content-security-policy");
      const scriptPolicy = policy.split("; ").find((part) => part.startsWith("script-src "));
      assert.ok(!scriptPolicy.includes("unsafe-inline"));
      assert.ok(!scriptPolicy.includes("unsafe-eval"));
      const nonce = scriptPolicy.match(/'nonce-([^']+)'/)?.[1];
      assert.match(nonce, /^[a-f0-9]{32}$/);
      nonces.push(nonce);
      assert.equal(await response.text(), html, "Production must not authorize development placeholders or unmarked scripts");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("etag"), null);
    }
    assert.notEqual(nonces[0], nonces[1]);
  } finally {
    await worker.dispose();
  }
});
