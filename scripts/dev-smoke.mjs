import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

// Exercise the actual Cloudflare/Vite configuration. The general UI smoke
// runner intentionally omits the Worker and cannot catch its HTML CSP errors.
let server;
let browser;
try {
  let baseUrl = process.env.KLIPPEE_DEV_SMOKE_URL;
  if (!baseUrl) {
    server = await createServer({
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      clearScreen: false,
      logLevel: "warn",
      server: { host: "127.0.0.1", port: 4176, strictPort: false },
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname), "Use a loopback Vite URL for development startup checks");
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const policy = response.headers.get("content-security-policy") ?? "";
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, "Development HTML must keep a nonce-based script policy");
  const scriptPolicy = policy.split("; ").find((part) => part.startsWith("script-src "));
  assert.ok(!scriptPolicy.includes("'unsafe-inline'"), "Script policy must not allow arbitrary inline scripts");
  const html = await response.text();
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes, source]) => !/\bsrc\s*=/.test(attributes) && source.trim());
  assert.ok(inlineScripts.some(([, , source]) => source.includes("injectIntoGlobalHook")), "Use the actual React refresh preamble");
  for (const [, attributes] of inlineScripts) {
    assert.ok(attributes.includes(`nonce="${nonce}"`), "React refresh startup script lacks a nonce allowed by CSP");
  }
  const secondResponse = await fetch(baseUrl);
  const secondNonce = secondResponse.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(secondNonce);
  assert.notEqual(secondNonce, nonce, "Each HTML response needs a fresh nonce");
  assert.ok((await secondResponse.text()).includes(`nonce="${secondNonce}"`));
  assert.equal(response.headers.get("cache-control"), "no-store");
  console.log("ok - React refresh inline scripts match the HTML security policy");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  let hmrConnections = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
    if (message.text().includes("[vite] connected")) hmrConnections += 1;
  });
  // Anonymous fixtures avoid reading or changing the developer's local account
  // data. HTML, scripts, styles and their security headers pass through intact.
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    assert.equal(route.request().method(), "GET", "Startup must not write account data");
    const payload = pathname === "/api/auth/me" ? { user: null }
      : pathname === "/api/packages" ? { packages: [] } : null;
    assert.ok(payload, `Unexpected startup API request: ${pathname}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(baseUrl, { waitUntil: "commit" });
  await page.getByRole("heading", { name: "Sign in required", exact: true }).waitFor({ timeout: 90_000 });
  console.log("ok - default route mounts under the real development security policy");
  await page.goto(new URL("/openscad-studio", baseUrl).href, { waitUntil: "commit" });
  await page.getByLabel("CAD source panel", { exact: true }).waitFor({ timeout: 90_000 });
  assert.ok((await page.getByRole("textbox", { name: /Source/ }).inputValue()).includes("cube("));
  assert.deepEqual(errors, [], "Development startup must not emit browser errors");
  assert.ok(hmrConnections > 0, "Vite's hot-reload WebSocket must connect");
  console.log("ok - OpenSCAD source panel mounts without browser startup errors");
  const inlineBlocked = await page.evaluate(() => new Promise((resolve) => {
    globalThis.__klippeeInlineProbe = false;
    const timeout = setTimeout(() => resolve(false), 2000);
    globalThis.document.addEventListener("securitypolicyviolation", (event) => {
      if (event.blockedURI === "inline" && event.effectiveDirective.startsWith("script-src")) {
        clearTimeout(timeout);
        resolve(!globalThis.__klippeeInlineProbe);
      }
    }, { once: true });
    const script = globalThis.document.createElement("script");
    script.textContent = "globalThis.__klippeeInlineProbe = true";
    globalThis.document.head.append(script);
  }));
  assert.equal(inlineBlocked, true, "Unmarked inline scripts must still be blocked");
  console.log("ok - hot reload connects and unmarked inline scripts remain blocked");
} finally {
  await browser?.close();
  await server?.close();
}
