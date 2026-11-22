import type { CompanionAsset } from "../src/types";
import { PublicCompanionAssetRepository } from "./repositories/PublicCompanionAssetRepository";
import { CompanionAssetRepository } from "./repositories/CompanionAssetRepository";
import { readDb } from "./db";
import type { CompanionAssetRow, Env, PublicCompanionAssetRow } from "./types";
import { isRecord, parseStringArray, slugify } from "./util";

export type CompanionAssetInput = {
  content: string;
  description: string;
  id?: string;
  kind: CompanionAsset["kind"];
  /** The printer this preset belongs to (OrcaSlicer presets are per-printer). */
  printerId?: string | null;
  public?: boolean;
  tags: string[];
  title: string;
  version?: string;
};

function isCompanionAssetKind(value: unknown): value is CompanionAsset["kind"] {
  return typeof value === "string" && ["filament", "machine", "process"].includes(value);
}

export function parseCompanionAssetInput(value: unknown): CompanionAssetInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const tags = value.tags === undefined ? [] : parseStringArray(value.tags);
  if (!tags) {
    return null;
  }

  if (
    typeof value.content !== "string" ||
    typeof value.description !== "string" ||
    !isCompanionAssetKind(value.kind) ||
    typeof value.title !== "string"
  ) {
    return null;
  }

  const title = value.title.trim();
  if (!title) {
    return null;
  }

  return {
    content: value.content,
    description: value.description.trim(),
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined,
    kind: value.kind,
    printerId: typeof value.printerId === "string" && value.printerId.trim() ? value.printerId.trim() : null,
    public: value.public === true,
    tags,
    title,
    version: typeof value.version === "string" && value.version.trim() ? value.version.trim() : undefined,
  };
}

export function companionAssetFromInput(input: CompanionAssetInput, id: string, timestamp: string): CompanionAsset {
  return {
    content: input.content,
    createdAt: timestamp,
    description: input.description,
    id,
    kind: input.kind,
    printerId: input.printerId ?? null,
    public: false,
    tags: input.tags,
    title: input.title,
    updatedAt: timestamp,
    version: input.version ?? "1",
  };
}

function isStoredCompanionAsset(parsed: Record<string, unknown>): parsed is Record<string, unknown> & CompanionAsset {
  return (
    typeof parsed.id === "string" &&
    typeof parsed.kind === "string" &&
    // Accept legacy kinds when reading so old rows don't error; new saves are
    // constrained to preset types by parseCompanionAssetInput.
    ["slicer", "filament", "machine", "process"].includes(parsed.kind) &&
    typeof parsed.title === "string" &&
    typeof parsed.description === "string" &&
    typeof parsed.content === "string" &&
    typeof parsed.public === "boolean" &&
    typeof parsed.version === "string" &&
    typeof parsed.createdAt === "string" &&
    typeof parsed.updatedAt === "string"
  );
}

export function parseStoredCompanionAsset(assetJson: string): CompanionAsset | null {
  try {
    const parsed: unknown = JSON.parse(assetJson);
    if (isRecord(parsed) && isStoredCompanionAsset(parsed)) {
      const tags = parseStringArray(parsed.tags);
      return tags ? { ...parsed, tags } : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function companionAssetResponse(row: Pick<CompanionAssetRow, "asset_json">) {
  return parseStoredCompanionAsset(row.asset_json);
}

export function publicCompanionAssetResponse(origin: string, row: PublicCompanionAssetRow) {
  const asset = parseStoredCompanionAsset(row.asset_json);
  return asset
    ? {
        ...asset,
        public: true,
        publicSlug: row.slug,
        publicUrl: `${origin}/assets/${row.slug}`,
        publishedAt: row.published_at,
        printerConfig: row.printer_config_slug && row.printer_config_title
          ? { slug: row.printer_config_slug, title: row.printer_config_title } : null,
      }
    : null;
}

export function createPublicCompanionAssetPlan({
  asset,
  origin,
  rowId,
  timestamp,
  userId,
}: {
  asset: CompanionAsset;
  origin: string;
  rowId: string;
  timestamp: string;
  userId: string;
}) {
  const slug = slugify(`${asset.title}-${asset.kind}-${asset.id}`) || slugify(asset.id);
  const publicAsset: CompanionAsset = { ...asset, public: true, updatedAt: timestamp };

  return {
    response: {
      asset: {
        ...publicAsset,
        publicSlug: slug,
        publicUrl: `${origin}/assets/${slug}`,
        publishedAt: timestamp,
      },
      publishedAt: timestamp,
      sharePath: `/assets/${slug}`,
      shareUrl: `${origin}/assets/${slug}`,
      slug,
    },
    row: {
      asset_json: JSON.stringify(publicAsset),
      created_at: timestamp,
      id: rowId,
      kind: asset.kind,
      published_at: timestamp,
      slug,
      source_asset_id: asset.id,
      title: asset.title,
      updated_at: timestamp,
      user_id: userId,
    },
  };
}

export async function loadOwnedCompanionAssets(env: Env, userId: string, ids: string[]) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return [];
  }

  const assets: CompanionAsset[] = [];
  for (const id of uniqueIds) {
    const row = await CompanionAssetRepository.getOwned(readDb(env), userId, id);
    const asset = row ? companionAssetResponse(row) : null;
    if (asset) {
      assets.push(asset);
    }
  }
  return assets;
}

export async function loadPublicCompanionAssets(env: Env, userId: string, ids: string[], origin: string) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return [];
  }

  const assets: ReturnType<typeof publicCompanionAssetResponse>[] = [];
  for (const id of uniqueIds) {
    const row = await PublicCompanionAssetRepository.getOwnedSource(readDb(env), userId, id);
    const asset = row ? publicCompanionAssetResponse(origin, row) : null;
    if (asset) {
      assets.push(asset);
    }
  }
  return assets;
}
