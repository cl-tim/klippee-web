import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { unwrapDatabaseError } from "./databaseErrors";

describe("database error boundaries", () => {
  it("preserves the D1 cause without logging private query parameters or wrapper stacks", () => {
    const cause = new Error("D1_ERROR: UNIQUE constraint failed: repository_versions.id");
    const wrapped = new DrizzleQueryError("insert into private_packages values (?)", ["private-config-secret"], cause);
    expect(wrapped.message).toContain("private-config-secret");
    const safe = unwrapDatabaseError(wrapped);
    expect(safe).toBe(cause);
    expect(JSON.stringify(safe instanceof Error ? { message: safe.message, stack: safe.stack } : safe)).not.toContain("private-config-secret");
    expect(safe instanceof Error && safe.message).toContain("UNIQUE constraint failed");
  });
  it("unwraps nested query errors and fails closed for a missing cause or a cycle", () => {
    const cause = new Error("SQLITE_BUSY");
    expect(unwrapDatabaseError(new DrizzleQueryError("select ?", ["secret"], new DrizzleQueryError("select ?", ["secret"], cause)))).toBe(cause);
    const missing = new DrizzleQueryError("select ?", ["secret"]);
    expect(unwrapDatabaseError(missing)).toEqual(new Error("Database operation failed"));
    missing.cause = missing;
    expect(unwrapDatabaseError(missing)).toEqual(new Error("Database operation failed"));
  });
  it("leaves ordinary application errors and non-error values unchanged", () => {
    const error = new Error("Application validation failed");
    expect(unwrapDatabaseError(error)).toBe(error);
    expect(unwrapDatabaseError("not an Error")).toBe("not an Error");
  });
});
