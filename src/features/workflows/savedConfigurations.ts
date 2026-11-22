export type SavedConfiguration = {
  id: string;
  name: string;
  title: string;
  updated_at: string;
  latest_version_id: string | null;
  version_count: number;
  pending_draft: number;
  linked_printer_count: number;
  published_listing_count: number;
  dependent_version_count: number;
};

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSavedConfiguration(value: unknown): value is SavedConfiguration {
  if (typeof value !== "object" || value === null) return false;
  return "id" in value && typeof value.id === "string" && value.id.length > 0
    && "name" in value && typeof value.name === "string"
    && "title" in value && typeof value.title === "string"
    && "updated_at" in value && typeof value.updated_at === "string" && Number.isFinite(Date.parse(value.updated_at))
    && "latest_version_id" in value && (value.latest_version_id === null || typeof value.latest_version_id === "string")
    && "version_count" in value && isCount(value.version_count)
    && "pending_draft" in value && (value.pending_draft === 0 || value.pending_draft === 1)
    && "linked_printer_count" in value && isCount(value.linked_printer_count)
    && "published_listing_count" in value && isCount(value.published_listing_count)
    && "dependent_version_count" in value && isCount(value.dependent_version_count);
}

export function parseSavedConfigurations(raw: unknown): { repositories: SavedConfiguration[] } | null {
  if (typeof raw !== "object" || raw === null || !("repositories" in raw)
    || !Array.isArray(raw.repositories) || !raw.repositories.every(isSavedConfiguration)) return null;
  return { repositories: raw.repositories };
}

export function configurationDeleteBlock(config: SavedConfiguration): string {
  const reasons = [];
  if (config.linked_printer_count) reasons.push("Linked to a printer in Klippee");
  if (config.published_listing_count) reasons.push("Used by a public listing");
  if (config.dependent_version_count) reasons.push("Used by another configuration's history");
  return reasons.join(". ");
}
