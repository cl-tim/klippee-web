import { describe, expect, it } from "vitest";
import { parseBearerToken, securityHeaders, withSecurityHeaders } from "./http";

describe("Cloudflare script policy", () => {
  it("allows the automatically injected analytics beacon without allowing arbitrary inline scripts", () => {
    const policy = securityHeaders()["content-security-policy"];
    expect(policy).toContain("script-src 'self' https://static.cloudflareinsights.com/beacon.min.js");
    expect(policy.split("; ").find((value) => value.startsWith("script-src "))).not.toContain("unsafe-inline");
  });

  it("gives each HTML response a fresh nonce for Cloudflare JavaScript Detections", () => {
    const html = () => new Response("<!doctype html><div id='root'></div>", {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600", etag: "cached" },
    });
    const first = withSecurityHeaders(html());
    const second = withSecurityHeaders(html());
    const nonce = (response: Response) => response.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce(first)).toMatch(/^[a-f0-9]{32}$/);
    expect(nonce(second)).not.toBe(nonce(first));
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.has("etag")).toBe(false);
  });

  it("keeps asset caching and API policies free of per-response nonces", () => {
    const response = withSecurityHeaders(new Response("export {}", {
      headers: { "content-type": "text/javascript", "cache-control": "public, max-age=31536000", etag: "asset" },
    }));
    expect(response.headers.get("content-security-policy")).not.toContain("nonce-");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000");
    expect(response.headers.get("etag")).toBe("asset");
  });
});

function request(authorization?: string) {
  return new Request("https://klippee.test/api/example", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("parseBearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(parseBearerToken(request("Bearer klp_token_1"))).toBe("klp_token_1");
  });

  it("matches the scheme case-insensitively", () => {
    expect(parseBearerToken(request("bearer klp_token_1"))).toBe("klp_token_1");
    expect(parseBearerToken(request("BEARER klp_token_1"))).toBe("klp_token_1");
  });

  it("returns null when the header is absent", () => {
    expect(parseBearerToken(request())).toBeNull();
  });

  it("returns null for other authentication schemes", () => {
    expect(parseBearerToken(request("Basic dXNlcjpwYXNz"))).toBeNull();
  });

  it("returns null for a bare Bearer scheme without a token", () => {
    // Headers normalization trims trailing whitespace, so "Bearer   "
    // arrives as "Bearer" and has no token to extract.
    expect(parseBearerToken(request("Bearer"))).toBeNull();
  });

  it("returns the raw token without trimming trailing content", () => {
    expect(parseBearerToken(request("Bearer  abc def"))).toBe("abc def");
  });
});
