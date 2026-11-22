import { cloudFetch } from "../cloudFetch";
import type { AuthUser } from "../types";
import type { CompanionAsset } from "../../types";

export function useCompanionAssetDeletion({ authUser, assets, isBusy, removeLocal, setStatus }: {
  authUser: AuthUser | null;
  assets: CompanionAsset[];
  isBusy: (id: string) => boolean;
  removeLocal: (id: string) => void;
  setStatus: (message: string) => void;
}) {
  return async function deleteCompanionAsset(id: string): Promise<boolean> {
    const asset = assets.find(candidate => candidate.id === id);
    if (!asset) { setStatus("Preset not found in this library. Reload before retrying."); return false; }
    if (isBusy(id)) { setStatus("This preset is still saving or publishing. Wait for it to finish, then review the deletion again."); return false; }
    if (!authUser) {
      removeLocal(id);
      setStatus("Removed the local copy. Sign in to remove a saved cloud copy.");
      return true;
    }
    let failure = "Couldn't confirm deletion. Reload the preset library before retrying.";
    const result = await cloudFetch(`/api/companion-assets/${encodeURIComponent(id)}`, {
      method: "DELETE", json: { updatedAt: asset.updatedAt },
      messages: { fail: failure, error: failure }, onStatus: message => { failure = message; },
      validate: raw => {
        if (typeof raw !== "object" || raw === null) return null;
        if ("ok" in raw && raw.ok === true && "deletedAssetId" in raw && raw.deletedAssetId === id) return { deleted: true, missing: false };
        if ("code" in raw && raw.code === "companion_asset_not_found") return { deleted: false, missing: true };
        return null;
      },
    });
    if ((result.ok && result.data?.deleted) || (result.status === 404 && result.data?.missing)) {
      removeLocal(id);
      setStatus("Preset removed from Klippee and this browser. Published copies and printer files were not changed.");
      return true;
    }
    setStatus(failure);
    return false;
  };
}
