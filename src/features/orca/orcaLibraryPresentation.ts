import type { OrcaLibrarySummary } from "./orcaCapture";

// Only recognize the namespace and filenames produced by prepare_restore /
// plan_import. Other local presets can be usable profiles in their own right.
function restoredPreset(name: string) {
  const match = /^_local\/klippee-restore-[a-f0-9]{12}-d\d+\/(saved-[a-f0-9]{20}|restored-\d+-[^/]+)$/.exec(name);
  if (!match) return null;
  if (match[1].startsWith("saved-")) return { supporting: true, name: "Restore dependency" };
  return {
    supporting: false,
    name: match[1].replace(/^restored-\d+-/, "").replace(/[-_]+/g, " ").trim() || "Restored profile",
  };
}

export function orcaLibraryProfiles(profiles: OrcaLibrarySummary["profiles"]) {
  return profiles.flatMap((profile) => {
    const restored = restoredPreset(profile.name);
    if (restored?.supporting) return [];
    const parent = profile.parent ? restoredPreset(profile.parent) : null;
    return [{
      ...profile,
      displayName: restored?.name ?? profile.name,
      sourceLabel: restored ? "Restored" : profile.custom ? "Custom" : profile.name.startsWith("_local/") ? "Local" : "Built-in",
      parentDisplayName: parent?.name ?? profile.parent,
    }];
  });
}
