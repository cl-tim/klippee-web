import { sql } from "drizzle-orm";
import { physicalPrinters as p } from "./schema";
import { describe, expect, it } from "vitest";
import { maxD1JsonRemovePathsPerStatement } from "./constants";
import { scrubPrinterSecretValueStatements, secretVariableJsonPaths } from "./packageSecrets";
import type { D1Client } from "./types";

describe("secretVariableJsonPaths", () => {
  it("maps valid names to SQLite JSON paths", () => {
    expect(secretVariableJsonPaths(["wifi_password", "api_key2"]))
      .toEqual(["$.wifi_password", "$.api_key2"]);
  });

  it("drops names outside the template-marker grammar", () => {
    expect(secretVariableJsonPaths([
      "Wifi_Password",
      "1password",
      "api-key",
      "a.b",
      "$.injected",
      "",
      "ok_name",
    ])).toEqual(["$.ok_name"]);
  });

  it("deduplicates while preserving first-seen order", () => {
    expect(secretVariableJsonPaths(["b_name", "a_name", "b_name"]))
      .toEqual(["$.b_name", "$.a_name"]);
  });

  it("accepts any iterable", () => {
    expect(secretVariableJsonPaths(new Set(["token"]))).toEqual(["$.token"]);
  });
});

describe("scrubPrinterSecretValueStatements", () => {
  const db: D1Client = {
    batch() { throw new Error("Query construction must not execute D1"); },
    prepare() { throw new Error("Query construction must not prepare D1 statements"); },
  };
  const normalized = (query: string) => query.replace(/"/g, "").replace(/printers\./g, "")
    .replace(/\s+/g, " ").trim().toLowerCase();

  it("returns no statements for no paths", () => {
    expect(scrubPrinterSecretValueStatements(db, [], sql`1 = 1`)).toEqual([]);
  });

  it("binds paths before the typed owner predicate", () => {
    const [statement] = scrubPrinterSecretValueStatements(db, ["$.a", "$.b"],
      sql`${p.id} = ${"printer_1"} and ${p.userId} = ${"user_1"}`);
    const query = statement.toSQL();
    expect(query.params).toEqual(["$.a", "$.b", "printer_1", "user_1"]);
    expect(normalized(query.sql)).toContain("json_remove(variable_values_json, ?, ?)");
    expect(normalized(query.sql)).toContain("where id = ? and user_id = ?");
    expect(query.sql).not.toContain("updated_at");
  });

  it("sets updated_at between the paths and owner predicate when provided", () => {
    const [statement] = scrubPrinterSecretValueStatements(db, ["$.a"],
      sql`${p.userId} = ${"user_1"}`, "2026-01-01T00:00:00.000Z");
    const query = statement.toSQL();
    expect(normalized(query.sql)).toContain("updated_at = ?");
    expect(query.params).toEqual(["$.a", "2026-01-01T00:00:00.000Z", "user_1"]);
  });

  it("chunks paths below D1's bound-argument ceiling", () => {
    const paths = Array.from({ length: maxD1JsonRemovePathsPerStatement + 9 }, (_unused, index) => `$.name_${index}`);
    const statements = scrubPrinterSecretValueStatements(db, paths, sql`${p.userId} = ${"user_1"}`);
    expect(statements).toHaveLength(2);
    expect(statements[0].toSQL().params).toHaveLength(maxD1JsonRemovePathsPerStatement + 1);
    expect(statements[1].toSQL().params).toEqual([...paths.slice(maxD1JsonRemovePathsPerStatement), "user_1"]);
  });
});
