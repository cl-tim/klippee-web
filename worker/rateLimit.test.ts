import { describe, expect, it, vi } from "vitest";
import { enforcePrincipalRateLimit } from "./rateLimit";
import type { RateLimiter } from "./types";

const options = {
  error: "Upload allowance exhausted.",
  resource: "test-uploads",
};

function createWindowedLimiter(limit: number, periodSeconds: number) {
  let now = 0;
  let epoch = 0;
  const counts = new Map<string, number>();
  const limiter: RateLimiter = {
    async limit({ key }) {
      const currentEpoch = Math.floor(now / (periodSeconds * 1_000));
      if (currentEpoch !== epoch) {
        epoch = currentEpoch;
        counts.clear();
      }
      const count = counts.get(key) ?? 0;
      if (count >= limit) return { success: false };
      counts.set(key, count + 1);
      return { success: true };
    },
  };

  return {
    advance(milliseconds: number) {
      now += milliseconds;
    },
    limiter,
  };
}

describe("authenticated upload rate limiting", () => {
  it("exhausts one principal independently and recovers after the configured window", async () => {
    const clock = createWindowedLimiter(2, 60);

    expect(await enforcePrincipalRateLimit(clock.limiter, "principal-a", options)).toBeNull();
    expect(await enforcePrincipalRateLimit(clock.limiter, "principal-a", options)).toBeNull();

    const limited = await enforcePrincipalRateLimit(clock.limiter, "principal-a", options);
    expect(limited).not.toBeNull();
    if (!limited) throw new Error("Expected a rate-limit response");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toEqual({
      code: "upload_rate_limit_exceeded",
      error: options.error,
      resource: options.resource,
      retryAfterSeconds: 60,
    });

    expect(await enforcePrincipalRateLimit(clock.limiter, "principal-b", options)).toBeNull();

    clock.advance(60_000);
    expect(await enforcePrincipalRateLimit(clock.limiter, "principal-a", options)).toBeNull();
  });

  it("fails closed when the binding is missing or throws", async () => {
    const missing = await enforcePrincipalRateLimit(undefined, "principal-a", options);
    if (!missing) throw new Error("Expected a missing-binding response");
    expect(missing.status).toBe(503);
    expect(missing.headers.get("retry-after")).toBe("60");
    await expect(missing.json()).resolves.toEqual({
      code: "upload_rate_limit_unavailable",
      error: "Upload protection is temporarily unavailable. Retry shortly.",
      resource: options.resource,
      retryAfterSeconds: 60,
    });

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unavailable: RateLimiter = {
      limit: vi.fn().mockRejectedValue(new Error("binding unavailable")),
    };
    const failed = await enforcePrincipalRateLimit(unavailable, "principal-a", options);

    if (!failed) throw new Error("Expected an unavailable-binding response");
    expect(failed.status).toBe(503);
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      error: "binding unavailable",
      level: "error",
      resource: options.resource,
      type: "upload_rate_limiter_unavailable",
    }));
  });
});
