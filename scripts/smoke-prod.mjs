import { deploymentOrigin } from "./deployment-origin.mjs";

const baseUrl = deploymentOrigin(process.env.KLIPPEE_BASE_URL, "Set KLIPPEE_BASE_URL to the instance to check.");
const requirePublicPackage = process.env.KLIPPEE_REQUIRE_PUBLIC_PACKAGE === "1";
const requestTimeoutMs = Number(process.env.KLIPPEE_SMOKE_TIMEOUT_MS ?? "15000");

const requiredStaticHeaders = [
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
];

async function fetchCheck(path, options = {}) {
  const { bodyType = "text", ...fetchOptions } = options;
  const url = new URL(path, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      ...fetchOptions,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${url.toString()} timed out after ${requestTimeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const bytes = bodyType === "bytes" ? new Uint8Array(await response.arrayBuffer()) : null;
  const text = bytes ? "" : await response.text();
  return {
    bytes,
    headers: response.headers,
    ok: response.ok,
    status: response.status,
    text,
    url: url.toString(),
  };
}

function parseJson(result) {
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`${result.url} did not return JSON: ${result.text.slice(0, 160)}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function valuesForPackage(pkg) {
  const values = {};
  for (const variable of pkg.variables ?? []) {
    if (variable.secret) {
      continue;
    }

    if (variable.example) {
      values[variable.name] = variable.example;
      continue;
    }

    if (variable.type === "device-path" || variable.type === "serial-id") {
      values[variable.name] = "/dev/serial/by-id/klippee-smoke";
    } else if (variable.type === "hostname") {
      values[variable.name] = "klippee-smoke.local";
    } else if (variable.type === "ip-address") {
      values[variable.name] = "192.0.2.10";
    } else if (variable.type === "number") {
      values[variable.name] = "1";
    } else if (variable.type === "boolean") {
      values[variable.name] = "true";
    } else if (variable.type === "url") {
      values[variable.name] = baseUrl.origin;
    } else {
      values[variable.name] = "klippee-smoke";
    }
  }
  return values;
}

function packageCanSmokeRender(pkg) {
  return (
    pkg &&
    typeof pkg.id === "string" &&
    Array.isArray(pkg.files) &&
    pkg.files.length > 0 &&
    Array.isArray(pkg.variables) &&
    !pkg.variables.some((variable) => variable.required && variable.secret)
  );
}

function assertPublicPackageGovernance(pkg) {
  assert(typeof pkg.name === "string" && pkg.name.trim(), "public package is missing name");
  assert(typeof pkg.title === "string" && pkg.title.trim(), `${pkg.name} is missing title`);
  assert(typeof pkg.version === "string" && pkg.version.trim(), `${pkg.name} is missing version`);
  assert(typeof pkg.description === "string" && pkg.description.trim(), `${pkg.name} is missing description`);
  assert(Array.isArray(pkg.hardware), `${pkg.name} is missing hardware metadata`);
  assert(Array.isArray(pkg.tags), `${pkg.name} is missing tags`);
  assert(Array.isArray(pkg.variables), `${pkg.name} is missing variables`);
  assert(Array.isArray(pkg.warnings), `${pkg.name} is missing warnings`);
  assert(Array.isArray(pkg.files) && pkg.files.length > 0, `${pkg.name} is missing files`);

  for (const file of pkg.files) {
    assert(file.public === true, `${pkg.name} includes non-public file ${file.path}`);
    assert(!/(^|\/)\.klippee(\/|$)/i.test(file.path), `${pkg.name} exposes .klippee metadata`);
    assert(!/saved_variables\.cfg$/i.test(file.path), `${pkg.name} exposes runtime saved_variables.cfg`);
    assert(!/\.(bak|bkp|log|zip|tar|gz|7z|rar)$/i.test(file.path), `${pkg.name} exposes backup/archive ${file.path}`);
    assert(!/\/dev\/serial\/by-id\/[^\s#]+/i.test(file.content ?? ""), `${pkg.name} exposes a resolved serial path`);
  }
}

function assertOAuthRedirect(result, provider) {
  const location = result.headers.get("location");
  assert([301, 302, 303, 307, 308].includes(result.status), `${result.url} did not redirect`);
  assert(location, `${result.url} did not include a location header`);
  const redirect = new URL(location);
  const expectedHost = provider === "github" ? "github.com" : "discord.com";
  const expectedCallback = new URL(`/api/auth/${provider}/callback`, baseUrl).toString();
  assert(redirect.hostname === expectedHost, `${result.url} redirected to ${redirect.hostname}`);
  assert(redirect.searchParams.get("client_id"), `${result.url} did not include client_id`);
  assert(redirect.searchParams.get("client_id") !== "undefined", `${result.url} has an undefined client_id`);
  assert(redirect.searchParams.get("redirect_uri") === expectedCallback, `${result.url} has wrong redirect_uri`);
  assert(redirect.searchParams.get("state"), `${result.url} did not include state`);
  assert(
    redirect.searchParams.get("code_challenge_method") === "S256",
    `${result.url} did not require S256 PKCE`,
  );
  assert(
    /^[A-Za-z0-9_-]{43}$/.test(redirect.searchParams.get("code_challenge") ?? ""),
    `${result.url} did not include a valid PKCE challenge`,
  );
  assert(!redirect.searchParams.has("code_verifier"), `${result.url} exposed the PKCE verifier`);
}

async function main() {
  const failures = [];
  let smokePackage = null;
  let smokePackageValues = {};
  const checks = [
    ["Shared Configs URL and legacy redirect", async () => {
      for (const path of ["/registry", "/registry/?type=orca"]) {
        const result = await fetchCheck(path);
        assert(result.status === 308, `${result.url} did not permanently redirect`);
        const expected = new URL(`/shared-configs${new URL(path, baseUrl).search}`, baseUrl);
        assert(result.headers.get("location") === expected.href, `${result.url} lost its destination or query string`);
      }
      const result = await fetchCheck("/shared-configs");
      assert(result.status === 200, `${result.url} returned ${result.status}`);
      assert(result.text.includes('id="root"'), `${result.url} did not serve the app shell`);
    }],
    ["static app shell", async () => {
      const result = await fetchCheck("/");
      assert(result.status === 200, `${result.url} returned ${result.status}`);
      for (const header of requiredStaticHeaders) {
        assert(result.headers.has(header), `${result.url} is missing ${header}`);
      }
      const policy = result.headers.get("content-security-policy");
      const scripts = policy.split(";").map((directive) => directive.trim()).find((directive) => directive.startsWith("script-src ")) ?? "";
      assert(scripts.includes("https://static.cloudflareinsights.com/beacon.min.js"), "CSP blocks Cloudflare Web Analytics");
      assert(/'nonce-[a-f0-9]{32}'/.test(scripts), "HTML CSP is missing the Cloudflare JavaScript Detections nonce");
      assert(!scripts.includes("'unsafe-inline'"), "HTML CSP must not allow arbitrary inline scripts");
      assert(result.headers.get("cache-control") === "no-store", "HTML nonce responses must not be cached");
    }],
    ["anonymous auth", async () => {
      const result = await fetchCheck("/api/auth/me");
      assert(result.status === 200, `${result.url} returned ${result.status}`);
      const payload = parseJson(result);
      assert("user" in payload, `${result.url} did not include user`);
    }],
    ["oauth redirect starts", async () => {
      assertOAuthRedirect(await fetchCheck("/api/auth/github/start"), "github");
      assertOAuthRedirect(await fetchCheck("/api/auth/discord/start"), "discord");
    }],
    ["private APIs reject anonymous requests", async () => {
      for (const path of ["/api/repos", "/api/printers", "/api/private-packages", "/api/app-state"]) {
        const result = await fetchCheck(path);
        assert(result.status === 401, `${result.url} returned ${result.status} instead of 401`);
      }
    }],
    ["transient CAD service", async () => {
      const result = await fetchCheck("/api/cad/health");
      assert(result.status === 200, `${result.url} returned ${result.status}`);
      const payload = parseJson(result);
      assert(payload.ok === true, `${result.url} did not report healthy`);
      assert(payload.storage === "none", `${result.url} did not confirm storage is disabled`);
      assert(payload.engines?.build123dRender === "build123d", `${result.url} did not advertise build123d rendering`);
      assert(!Object.hasOwn(payload.engines, "cadQueryRender"), `${result.url} still advertises the removed CadQuery renderer`);
    }],
    ["package catalog", async () => {
      const result = await fetchCheck("/api/packages");
      assert(result.status === 200, `${result.url} returned ${result.status}`);
      const payload = parseJson(result);
      assert(Array.isArray(payload.packages), `${result.url} did not include packages array`);
      smokePackage = payload.packages.find(packageCanSmokeRender) ?? null;
      smokePackageValues = smokePackage ? valuesForPackage(smokePackage) : {};
      if (requirePublicPackage) {
        assert(smokePackage, `${result.url} did not include a renderable public package`);
        assertPublicPackageGovernance(smokePackage);
      }
    }],
    ["public package render", async () => {
      if (!smokePackage) {
        assert(!requirePublicPackage, "No renderable public package available");
        return;
      }
      const result = await fetchCheck(`/api/packages/${encodeURIComponent(smokePackage.id)}/render-preview`, {
        body: JSON.stringify({ variables: smokePackageValues }),
        headers: {
          "content-type": "application/json",
          origin: baseUrl.origin,
        },
        method: "POST",
      });
      assert(result.status === 200, `${result.url} returned ${result.status}`);
      const payload = parseJson(result);
      assert(payload.ok === true, `${result.url} package render was not ok`);
      assert(Array.isArray(payload.files) && payload.files.length > 0, `${result.url} returned no rendered files`);
    }],
    ["public package zip", async () => {
      if (!smokePackage) {
        assert(!requirePublicPackage, "No renderable public package available");
        return;
      }
      const result = await fetchCheck(`/api/packages/${encodeURIComponent(smokePackage.id)}/download.zip`, {
        body: JSON.stringify({ variables: smokePackageValues }),
        bodyType: "bytes",
        headers: {
          accept: "application/zip",
          "content-type": "application/json",
          origin: baseUrl.origin,
        },
        method: "POST",
      });
      assert(result.status === 200, `${result.url} returned ${result.status}`);
      assert(result.headers.get("content-type")?.includes("application/zip"), `${result.url} did not return a zip`);
      assert(result.bytes?.[0] === 0x50 && result.bytes?.[1] === 0x4b, `${result.url} body was not a zip file`);
      assert(
        result.headers.get("x-klippee-artifact-storage") === "skipped",
        `${result.url} unexpectedly persisted its generated zip`,
      );
      assert(
        result.headers.get("x-klippee-artifact-storage-reason") === "ephemeral-download",
        `${result.url} did not report ephemeral artifact handling`,
      );
      assert(!result.headers.has("x-klippee-artifact-key"), `${result.url} exposed a nonexistent artifact key`);
    }],
    ["worker health", async () => {
      const result = await fetchCheck("/api/health");
      assert(result.status === 200, `${result.url} returned ${result.status}`);
      const payload = parseJson(result);
      assert(payload.ok === true, `${result.url} health was not ok`);
      assert(payload.checks?.d1 === true, `${result.url} did not confirm D1`);
      assert(payload.checks?.d1Schema === true, `${result.url} did not confirm the required D1 schema`);
      assert(payload.checks?.r2 === true, `${result.url} did not confirm R2`);
    }],
  ];

  for (const [name, check] of checks) {
    try {
      await check();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`not ok - ${name}`);
    }
  }

  if (failures.length > 0) {
    console.error("");
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
}

await main();
