import { DrizzleQueryError } from "drizzle-orm";

// Drizzle's wrapper message/stack contains SQL and bound values. Use the
// underlying D1 error for logging and constraint/retry classification instead.
export function unwrapDatabaseError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof DrizzleQueryError) {
    if (seen.has(current)) return new Error("Database operation failed");
    seen.add(current);
    current = current.cause;
  }
  return current instanceof Error ? current : new Error("Database operation failed");
}
