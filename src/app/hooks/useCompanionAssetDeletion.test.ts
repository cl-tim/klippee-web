import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCompanionAssetDeletion } from "./useCompanionAssetDeletion";
import { jsonResponse } from "../../test/appTestUtils";
import type { AuthUser } from "../types";
import type { CompanionAsset } from "../../types";

const asset: CompanionAsset = { id: "old/preset", title: "Old preset", kind: "filament", content: "{}", description: "", tags: [],
  public: true, version: "1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
const owner: AuthUser = { id: "u1", displayName: "Owner", avatarUrl: null, providers: [] };
function setup(authUser: AuthUser | null = owner, busy = false) {
  const removeLocal = vi.fn(), setStatus = vi.fn();
  const { result } = renderHook(() => useCompanionAssetDeletion({ authUser, assets: [asset], isBusy: () => busy, removeLocal, setStatus }));
  return { removeLocal, setStatus, remove: result.current };
}

describe("companion-asset deletion", () => {
  it("removes a signed-out local copy without a cloud request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const action = setup(null);
    expect(await action.remove(asset.id)).toBe(true);
    expect(action.removeLocal).toHaveBeenCalledExactlyOnceWith(asset.id);
    expect(fetch).not.toHaveBeenCalled();
    expect(action.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("local copy"));
  });
  it("requires a matching deletion receipt before clearing the cached copy", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true, deletedAssetId: asset.id })); vi.stubGlobal("fetch", fetch);
    const action = setup();
    expect(await action.remove(asset.id)).toBe(true);
    expect(action.removeLocal).toHaveBeenCalledExactlyOnceWith(asset.id);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/companion-assets/old%2Fpreset", expect.objectContaining({
      method: "DELETE", credentials: "include", body: JSON.stringify({ updatedAt: asset.updatedAt }),
    }));
  });
  it("accepts an authoritative missing-source response without deleting anything else", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: "companion_asset_not_found", error: "Companion asset not found" }, 404)));
    const action = setup(); expect(await action.remove(asset.id)).toBe(true);
    expect(action.removeLocal).toHaveBeenCalledExactlyOnceWith(asset.id);
  });
  const failures: Array<[number, unknown]> = [
    [409, { error: "Attached to a private package" }], [401, { error: "Sign in" }], [500, { error: "Unavailable" }],
    [404, { error: "Unknown route" }], [200, { ok: true, deletedAssetId: "different-id" }], [200, {}],
  ];
  it.each(failures)("retains local state on an unconfirmed %i response", async (status, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, status)));
    const action = setup(); expect(await action.remove(asset.id)).toBe(false);
    expect(action.removeLocal).not.toHaveBeenCalled();
  });
  it("retains local state after a lost response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const action = setup(); expect(await action.remove(asset.id)).toBe(false);
    expect(action.removeLocal).not.toHaveBeenCalled();
    expect(action.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("Couldn't confirm"));
  });
  it("does not race an in-flight save or publication", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const action = setup(owner, true); expect(await action.remove(asset.id)).toBe(false);
    expect(action.removeLocal).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
