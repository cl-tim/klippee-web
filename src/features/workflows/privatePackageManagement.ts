export type ManagedPrivatePackage = {
  id: string;
  name: string;
  title: string;
  updated_at: string;
  linked_printer_count: number;
  published_listing_count: number;
};

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isManagedPackage(value: unknown): value is ManagedPrivatePackage {
  if (typeof value !== "object" || value === null) return false;
  return "id" in value && typeof value.id === "string" && value.id.length > 0
    && "name" in value && typeof value.name === "string"
    && "title" in value && typeof value.title === "string"
    && "updated_at" in value && typeof value.updated_at === "string" && Number.isFinite(Date.parse(value.updated_at))
    && "linked_printer_count" in value && isCount(value.linked_printer_count)
    && "published_listing_count" in value && isCount(value.published_listing_count);
}

export function parseManagedPrivatePackages(raw: unknown): { packages: ManagedPrivatePackage[] } | null {
  if (typeof raw !== "object" || raw === null || !("packages" in raw)
    || !Array.isArray(raw.packages) || !raw.packages.every(isManagedPackage)) return null;
  return { packages: raw.packages };
}
