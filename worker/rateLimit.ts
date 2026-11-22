import { json } from "./http";
import type { RateLimiter } from "./types";

const uploadRateLimitRetryAfterSeconds = 60;

type PrincipalRateLimitOptions = {
  error: string;
  resource: string;
};

// Per-IP throttle for unauthenticated compute endpoints. Returns a 429 response
// when the caller is over budget, or null to continue. No-ops when the binding
// is absent (local dev / tests without a configured limiter).
export async function enforceRateLimit(
  limiter: RateLimiter | undefined,
  request: Request,
  scope: string,
  message: string,
) {
  if (!limiter) {
    return null;
  }
  const actor = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${scope}:${actor}` });
  if (success) {
    return null;
  }
  return json({ error: message }, { headers: { "retry-after": "60" }, status: 429 });
}

// Authenticated storage mutations use stable account-owned principals instead
// of IP addresses. Missing or unavailable production bindings fail closed so a
// deployment cannot silently accept expensive bodies without abuse controls.
export async function enforcePrincipalRateLimit(
  limiter: RateLimiter | undefined,
  key: string,
  options: PrincipalRateLimitOptions,
) {
  if (!limiter) {
    return rateLimitUnavailable(options.resource);
  }

  try {
    const { success } = await limiter.limit({ key });
    if (success) {
      return null;
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      level: "error",
      resource: options.resource,
      type: "upload_rate_limiter_unavailable",
    }));
    return rateLimitUnavailable(options.resource);
  }

  return json(
    {
      code: "upload_rate_limit_exceeded",
      error: options.error,
      resource: options.resource,
      retryAfterSeconds: uploadRateLimitRetryAfterSeconds,
    },
    {
      headers: { "retry-after": String(uploadRateLimitRetryAfterSeconds) },
      status: 429,
    },
  );
}

function rateLimitUnavailable(resource: string) {
  return json(
    {
      code: "upload_rate_limit_unavailable",
      error: "Upload protection is temporarily unavailable. Retry shortly.",
      resource,
      retryAfterSeconds: uploadRateLimitRetryAfterSeconds,
    },
    {
      headers: { "retry-after": String(uploadRateLimitRetryAfterSeconds) },
      status: 503,
    },
  );
}
