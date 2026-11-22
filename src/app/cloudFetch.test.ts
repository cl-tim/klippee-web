import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudFetch } from "./cloudFetch";

describe("cloudFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a structured server error instead of replacing it with a generic failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "storage_quota_exceeded",
      error: "Storage limit reached for printers.",
    }), {
      headers: { "content-type": "application/json" },
      status: 409,
    })));
    const onStatus = vi.fn();

    const result = await cloudFetch("/api/printers", {
      messages: { fail: "Printer save failed" },
      onStatus,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(onStatus).toHaveBeenLastCalledWith("Storage limit reached for printers.");
  });
});
