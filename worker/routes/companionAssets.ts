import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { json, readJsonBody } from "../http";
import {
  companionAssetFromInput,
  companionAssetResponse,
  createPublicCompanionAssetPlan,
  parseCompanionAssetInput,
  publicCompanionAssetResponse,
} from "../companionAssets";
import { drizzleDb, drizzleReadDb, readDb, writeDb } from "../db";
import { PublicCompanionAssetRepository } from "../repositories/PublicCompanionAssetRepository";
import { CompanionAssetRepository } from "../repositories/CompanionAssetRepository";
import { companionAssets, publicCompanionAssets } from "../schema";
import { maxCompanionAssetsPerUser, storageQuotaExceeded } from "../storageLimits";
import type { Env } from "../types";
import { nowIso } from "../util";
import { requireUser } from "./auth";

export async function listPublicCompanionAssets(request: Request, env: Env) {
  const query = new URL(request.url).searchParams;
  const search = (query.get("q") ?? "").trim().slice(0, 200).toLowerCase();
  const kind = query.get("kind") ?? "", nozzle = query.get("nozzle") ?? "";
  const offset = Number(query.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000
    || (kind !== "" && kind !== "machine" && kind !== "filament" && kind !== "process")
    || (nozzle && !/^\d+(?:\.\d+)?$/.test(nozzle))) return json({ error: "Invalid profile filters." }, { status: 400 });
  const db = drizzleReadDb(readDb(env));
  const p = publicCompanionAssets;
  const description = sql<string | null>`json_extract(${p.assetJson}, '$.description')`;
  const tags = sql<string | null>`json_extract(${p.assetJson}, '$.tags')`;
  const visibleKinds = inArray(p.kind, ["machine", "filament", "process"]);
  const rows = await db.select({
    kind: p.kind, title: p.title, publicSlug: p.slug, publishedAt: p.publishedAt,
    description, tags, version: sql<string | null>`json_extract(${p.assetJson}, '$.version')`,
  }).from(p).where(and(
    visibleKinds,
    kind ? eq(p.kind, kind) : undefined,
    search ? sql`instr(lower(${p.title} || ' ' || coalesce(${description}, '') || ' ' || coalesce(${tags}, '')), ${search}) > 0` : undefined,
    nozzle ? sql`EXISTS (SELECT 1 FROM json_each(${p.assetJson}, '$.tags') WHERE value IN (${`${nozzle} mm nozzle`}, 'No nozzle restriction'))` : undefined,
  )).orderBy(desc(p.publishedAt), asc(p.slug)).limit(25).offset(offset).all();
  const assets = rows.slice(0, 24).map(row => ({ ...row, tags: JSON.parse(row.tags || "[]") as string[] }));
  const sizes = await db.selectDistinct({ tag: sql<string>`value` }).from(p)
    .innerJoin(sql`json_each(${p.assetJson}, '$.tags')`, sql`true`)
    .where(and(visibleKinds, sql`value GLOB '* mm nozzle'`)).limit(100).all();
  return json({ assets, nextOffset: rows.length > 24 ? offset + 24 : null,
    nozzleSizes: sizes.map(row => row.tag.replace(/ mm nozzle$/, "")).filter(size => /^\d+(?:\.\d+)?$/.test(size)).sort((a, b) => Number(a) - Number(b)) });
}

export async function listCompanionAssets(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const rows = await CompanionAssetRepository.listForUser(writeDb(env), user.id);
  const assets = rows
    .map((row) => companionAssetResponse(row))
    .filter((asset): asset is NonNullable<typeof asset> => asset !== null);

  return json({ assets });
}

export async function saveCompanionAsset(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const parsedBody = await readJsonBody<{ asset?: unknown } | null>(request, 512_000, "Companion asset payload is too large");
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const input = parseCompanionAssetInput(parsedBody.value?.asset);
  if (!input) {
    return json({ error: "Companion asset must include kind, title, description, content, and tags" }, { status: 400 });
  }

  const timestamp = nowIso();
  const id = input.id ?? crypto.randomUUID();
  const db = writeDb(env);
  const existing = await CompanionAssetRepository.getSaveContext(db, user.id, id);
  if (!existing) {
    const usage = await CompanionAssetRepository.countForUser(db, user.id);
    if ((usage?.count ?? 0) >= maxCompanionAssetsPerUser) {
      return storageQuotaExceeded("companion-assets", maxCompanionAssetsPerUser);
    }
  }
  const existingAsset = existing ? companionAssetResponse(existing) : null;
  const asset = {
    ...companionAssetFromInput(input, id, existingAsset?.createdAt ?? timestamp),
    public: existingAsset?.public ?? false,
    updatedAt: timestamp,
    version: input.version ?? existingAsset?.version ?? "1",
  };

  const stored = await CompanionAssetRepository.save(db, {
    id, userId: user.id, kind: asset.kind, title: asset.title, assetJson: JSON.stringify(asset),
    createdAt: asset.createdAt, updatedAt: timestamp,
  }, existing?.asset_json);
  if ((stored.meta.changes ?? 0) !== 1) {
    if (existing) return json({ code: "companion_asset_save_conflict", error: "This preset changed or was deleted while saving. Reload it before retrying." }, { status: 409 });
    return storageQuotaExceeded("companion-assets", maxCompanionAssetsPerUser);
  }

  return json({ asset }, { status: existing ? 200 : 201 });
}

export async function getCompanionAsset(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const row = await CompanionAssetRepository.getOwned(writeDb(env), user.id, id);
  const asset = row ? companionAssetResponse(row) : null;
  if (!asset) {
    return json({ error: "Companion asset not found" }, { status: 404 });
  }

  return json({ asset });
}

export async function publishCompanionAsset(request: Request, env: Env, id: string) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const row = await CompanionAssetRepository.getOwned(writeDb(env), user.id, id);
  const asset = row ? companionAssetResponse(row) : null;
  if (!row || !asset) {
    return json({ error: "Companion asset not found" }, { status: 404 });
  }

  const timestamp = nowIso();
  const plan = createPublicCompanionAssetPlan({
    asset,
    origin: env.APP_ORIGIN,
    rowId: crypto.randomUUID(),
    timestamp,
    userId: user.id,
  });

  const q = drizzleDb(writeDb(env)), r = plan.row;
  await q.batch([
    q.insert(publicCompanionAssets).values({ id: r.id, userId: r.user_id, sourceAssetId: r.source_asset_id,
      slug: r.slug, kind: r.kind, title: r.title, assetJson: r.asset_json, createdAt: r.created_at,
      updatedAt: r.updated_at, publishedAt: r.published_at,
    }).onConflictDoUpdate({ target: [publicCompanionAssets.userId, publicCompanionAssets.sourceAssetId], set: {
      slug: r.slug, kind: r.kind, title: r.title, assetJson: r.asset_json, updatedAt: r.updated_at, publishedAt: r.published_at,
    } }),
    q.update(companionAssets).set({ assetJson: JSON.stringify({ ...asset, public: true, updatedAt: timestamp }), updatedAt: timestamp })
      .where(and(eq(companionAssets.userId, user.id), eq(companionAssets.id, id), eq(companionAssets.assetJson, row.asset_json))),
  ]);

  return json(plan.response, { status: 201 });
}

export async function getPublicCompanionAsset(env: Env, slug: string) {
  const row = await PublicCompanionAssetRepository.getBySlug(readDb(env), slug);
  const asset = row ? publicCompanionAssetResponse(env.APP_ORIGIN, row) : null;
  if (!asset) {
    return json({ error: "Companion asset not found" }, { status: 404 });
  }

  return json({ asset });
}

export async function getPublicConfigOrcaProfiles(env: Env, slug: string) {
  const rows = await PublicCompanionAssetRepository.listConfigProfiles(readDb(env), slug);
  return json({ assets: rows.map(row => ({ ...row, tags: JSON.parse(row.tags || "[]") as string[] })) });
}
