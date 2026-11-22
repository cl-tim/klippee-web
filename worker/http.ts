import { maxJsonBodyBytes, oauthStateCookieName, sessionCookieName } from "./constants";
import type { Env } from "./types";
import { viteNoncePlaceholder } from "./viteNonce";

export function securityHeaders(scriptNonce?: string) {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self' https://fonts.gstatic.com",
      "form-action 'self' https://github.com https://discord.com",
      "frame-ancestors 'none'",
      "img-src 'self' https: data:",
      "object-src 'none'",
      `script-src 'self' https://static.cloudflareinsights.com/beacon.min.js${scriptNonce ? ` 'nonce-${scriptNonce}'` : ""}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    ].join("; "),
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  };
}

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    headers: {
      "cache-control": "no-store",
      ...securityHeaders(),
      ...init?.headers,
    },
    status: init?.status,
    statusText: init?.statusText,
  });
}

export function redirect(location: string, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("location", location);
  for (const [name, value] of Object.entries(securityHeaders())) {
    responseHeaders.set(name, value);
  }

  return new Response(null, {
    headers: responseHeaders,
    status: 302,
  });
}

export function withSecurityHeaders(response: Response, { viteDevelopment = false }: { viteDevelopment?: boolean } = {}) {
  const headers = new Headers(response.headers);
  const isHtml = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "text/html";
  // Cloudflare reads the response CSP and copies this nonce onto its injected
  // JavaScript Detections scripts. Never reuse it through an HTML cache.
  const scriptNonce = isHtml ? crypto.randomUUID().replaceAll("-", "") : undefined;
  if (isHtml) {
    headers.set("cache-control", "no-store");
    headers.delete("etag");
    headers.delete("last-modified");
  }
  for (const [name, value] of Object.entries(securityHeaders(scriptNonce))) {
    headers.set(name, value);
  }
  const secured = new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
  if (!viteDevelopment || !scriptNonce) return secured;

  // ASSETS has already run Vite's HTML transforms. Replace its marked nonce
  // attributes while streaming; unmarked inline scripts stay unauthorized.
  return new HTMLRewriter().on(`[nonce="${viteNoncePlaceholder}"]`, {
    element(element) {
      element.setAttribute("nonce", scriptNonce);
    },
  }).transform(secured);
}

export async function readJsonBody<T = unknown>(
  request: Request,
  maxBytes = maxJsonBodyBytes,
  oversizedError = "Payload is too large",
): Promise<
  | { ok: true; value: T }
  | { ok: false; response: Response }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = /^\d+$/.test(contentLength) ? Number(contentLength) : Number.NaN;
    if (!Number.isSafeInteger(parsedLength)) {
      return { ok: false, response: json({ error: "Invalid Content-Length" }, { status: 400 }) };
    }
    if (parsedLength > maxBytes) {
      return { ok: false, response: json({ error: oversizedError }, { status: 413 }) };
    }
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        byteLength += value.byteLength;
        if (byteLength > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The size check has already rejected the body; cancellation is best-effort.
          }
          return { ok: false, response: json({ error: oversizedError }, { status: 413 }) };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bodyBytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const bodyText = new TextDecoder().decode(bodyBytes);

  try {
    return { ok: true, value: JSON.parse(bodyText || "{}") as T };
  } catch {
    return { ok: false, response: json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header. Returns
 * the raw (untrimmed) token so callers keep their existing hashing semantics,
 * or null when the header is absent or not a Bearer scheme.
 */
export function parseBearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

/**
 * Timing-safe comparison of a static operator bearer token. Responds 503 when
 * the expected secret is not configured and 401 when the provided token does
 * not match; returns null when the caller is authorized. Both sides are
 * SHA-256 hashed so `timingSafeEqual` always compares equal-length buffers.
 */
export async function requireStaticBearerToken(
  request: Request,
  expectedSecret: string | undefined,
  messages: { notConfigured: string; unauthorized: string },
): Promise<Response | null> {
  const expected = expectedSecret?.trim();
  if (!expected) {
    return json({ error: messages.notConfigured }, { status: 503 });
  }
  const provided = parseBearerToken(request)?.trim() ?? "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (!crypto.subtle.timingSafeEqual(providedHash, expectedHash)) {
    return json({ error: messages.unauthorized }, { status: 401 });
  }
  return null;
}

export function parseCookies(request: Request) {
  const header = request.headers.get("cookie") ?? "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const [name, ...value] = trimmed.split("=");
    try {
      cookies[name] = decodeURIComponent(value.join("="));
    } catch {
      cookies[name] = value.join("=");
    }
  }
  return cookies;
}

export function sessionCookie(token: string, expires: string) {
  return `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(
    expires,
  ).toUTCString()}`;
}

export function clearSessionCookie() {
  return `${sessionCookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function oauthStateCookie(state: string, expires: string) {
  return `${oauthStateCookieName}=${encodeURIComponent(state)}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(
    expires,
  ).toUTCString()}`;
}

export function clearOAuthStateCookie() {
  return `${oauthStateCookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function isTrustedOrigin(request: Request, env: Env) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }

  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = new URL(env.APP_ORIGIN).origin;
  return origin === requestOrigin || origin === configuredOrigin;
}

export function requiresBrowserOriginCheck(request: Request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return false;
  }

  const path = new URL(request.url).pathname;
  // Native Orca routes accept only an explicitly scoped bearer credential.
  if ((request.method === "POST" && ["/api/orca/restore/library", "/api/orca/restore/profile", "/api/orca/restore/pair", "/api/orca/restore/disconnect", "/api/orca/device/upload-connection"].includes(path)) || path === "/api/orca/capture" || path === "/api/orca/capture/context" || (path === "/api/orca/library" && request.method === "POST")) return false;
  return !path.startsWith("/api/sync/") && !path.startsWith("/api/internal/storage/");
}
