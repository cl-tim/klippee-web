import { sql } from "drizzle-orm";
import { drizzleDb, writeDb } from "../db";
import { json } from "../http";
import type { Env } from "../types";
import { nowIso } from "../util";
import { unwrapDatabaseError } from "../databaseErrors";

// Keep this marker synchronized with the newest migration. Membership is
// deliberate: migrations run before the Worker deploy, so the previous Worker
// must stay healthy when a newer migration is already present.
export const requiredD1Migration = "0030_repository_history_reference_index.sql";

export async function healthCheck(env: Env) {
  const checks = {
    d1: false,
    d1Schema: false,
    r2: false,
  };
  const errors: Record<string, string> = {};

  try {
    const db = drizzleDb(writeDb(env));
    const result = await db.get<{ ok: number } | undefined>(sql`SELECT 1 AS ok`);
    checks.d1 = result?.ok === 1;

    if (checks.d1) {
      const migration = await db.get<{ name: string } | undefined>(sql`SELECT name
         FROM d1_migrations
         WHERE name = ${requiredD1Migration}
         LIMIT 1`);
      checks.d1Schema = migration?.name === requiredD1Migration;
    }
  } catch (caught) {
    const error = unwrapDatabaseError(caught);
    errors[checks.d1 ? "d1Schema" : "d1"] = error instanceof Error
      ? error.message
      : String(error);
  }

  try {
    await env.BLOBS.head("health/nonexistent");
    checks.r2 = true;
  } catch (error) {
    errors.r2 = error instanceof Error ? error.message : String(error);
  }

  const ok = Object.values(checks).every(Boolean);
  if (!ok) {
    console.error({
      level: "error",
      type: "health_check_failure",
      failedChecks: Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name),
      errors,
    });
  }

  return json(
    {
      checks,
      ok,
      service: "klippee",
      timestamp: nowIso(),
    },
    { status: ok ? 200 : 503 },
  );
}
