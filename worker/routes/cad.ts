import { maxCadBodyBytes } from "../constants";
import { json, securityHeaders, withSecurityHeaders } from "../http";
import { enforceRateLimit } from "../rateLimit";
import type { Env } from "../types";

const CAD_CONTAINER_INSTANCE = "cad-engine-api";

function forwardedCadHeaders(request: Request) {
  const headers = new Headers();
  for (const name of ["accept", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

// Fail-open by design: the stateless CAD proxy stays usable in local dev and
// tests where no rate-limiter binding is configured. Only POSTs are limited.
function rateLimitCad(request: Request, env: Env) {
  if (request.method !== "POST") return null;
  return enforceRateLimit(
    env.CAD_RATE_LIMITER,
    request,
    "cad",
    "CAD request limit reached. Try again shortly.",
  );
}

export async function proxyCad(request: Request, env: Env, apiPath: string[]) {
  if (!(["GET", "HEAD", "POST", "OPTIONS"] as string[]).includes(request.method)) {
    return json({ error: "Method not allowed" }, { headers: { allow: "GET, HEAD, POST, OPTIONS" }, status: 405 });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { allow: "GET, HEAD, POST, OPTIONS", ...securityHeaders() }, status: 204 });
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (request.method === "POST" && request.body && contentLengthHeader === null) {
    return json({ error: "CAD requests with a body require Content-Length" }, { status: 411 });
  }
  const contentLength = contentLengthHeader === null || /^\d+$/.test(contentLengthHeader)
    ? Number(contentLengthHeader ?? "0")
    : Number.NaN;
  if (!Number.isSafeInteger(contentLength)) {
    return json({ error: "Invalid Content-Length header" }, { status: 400 });
  }
  if (contentLength > maxCadBodyBytes) {
    return json({ error: "CAD payload is too large" }, { status: 413 });
  }
  const limited = await rateLimitCad(request, env);
  if (limited) return limited;

  const sourceUrl = new URL(request.url);
  const targetPath = `/api/${apiPath.join("/")}`;
  const targetUrl = new URL(`${targetPath}${sourceUrl.search}`, sourceUrl.origin);
  const init: RequestInit = {
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    headers: forwardedCadHeaders(request),
    method: request.method,
  };

  try {
    const response = env.CAD_API_BASE
      ? await fetch(new URL(`${targetPath}${sourceUrl.search}`, env.CAD_API_BASE), init)
      : await env.CAD_CONTAINER.getByName(CAD_CONTAINER_INSTANCE).fetch(new Request(targetUrl, init));

    if (response.status >= 500) {
      return json({ error: "CAD service unavailable" }, { status: 503 });
    }
    return withSecurityHeaders(response);
  } catch {
    return json({ error: "CAD service unavailable" }, { status: 503 });
  }
}
