import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { RunnableQuery } from "drizzle-orm/runnable-query";
import type { D1Client, Env } from "./types";

export function readDb(env: Env) {
  return env.DB.withSession("first-unconstrained");
}

export function writeDb(env: Env) {
  return env.DB.withSession("first-primary");
}

export type DrizzleDb = Pick<DrizzleD1Database,
  "select" | "selectDistinct" | "insert" | "update" | "delete" | "batch" | "run" | "all" | "get" | "$with" | "with">;

// Non-returning write builders share D1 metadata while retaining statement
// preparation. Raw SQL operations intentionally do not satisfy this boundary.
export type DrizzleWriteQuery = RunnableQuery<Awaited<ReturnType<DrizzleDb["run"]>>, "sqlite"> & {
  prepare(): unknown;
  toSQL(): { sql: string; params: unknown[] };
};
export type DrizzleWriteBatch = [DrizzleWriteQuery, ...DrizzleWriteQuery[]];

export function drizzleDb(session: D1Client): DrizzleDb {
  // Drizzle 0.45's D1 driver uses prepare/batch but requires the wider
  // D1Database type. Keep every query on the caller's session, and fail closed
  // if a future driver starts using an operation that bypasses that session.
  const unsupported = () => { throw new Error("Drizzle requires prepared statements in the existing D1 session."); };
  const client: D1Database = {
    prepare: (query) => session.prepare(query),
    batch: <T>(statements: D1PreparedStatement[]) => session.batch<T>(statements),
    exec: unsupported,
    dump: unsupported,
    withSession: unsupported,
  };
  return drizzle(client);
}

export function drizzleReadDb(session: D1Client): Pick<DrizzleDb, "select" | "selectDistinct"> {
  return drizzleDb(session);
}
