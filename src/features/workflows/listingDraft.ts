import type { PackageDraft } from "../../app/types";
import type { ConfigPackage } from "../../types";

/**
 * Registry listing metadata derived from a package: the shared mapping used by
 * both the public listing editor (RegistryView detail) and the registry
 * publisher modal so their drafts never drift apart.
 */
export function listingDraftFor(pkg: ConfigPackage): PackageDraft {
  return {
    description: pkg.description,
    hardware: pkg.hardware.join(", "),
    printer: pkg.printer,
    tags: pkg.tags.filter((tag) => tag !== "private" && tag !== "public").join(", "),
    title: pkg.title,
  };
}

/** Case-insensitively deduped, comma-split, trimmed suggestion values. */
export function uniqueSuggestions(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  return values
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter((value) => {
      const normalized = value.toLowerCase();
      if (!value || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}
