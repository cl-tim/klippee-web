import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "../../worker/schema.ts";
import { applyMigrations, createWorkerMiniflare } from "./helpers.mjs";

describe("Drizzle D1 models", () => {
  let mf, db;
  before(async () => {
    mf = createWorkerMiniflare();
    db = await mf.getD1Database("DB");
    await applyMigrations(db);
  });
  after(async () => mf?.dispose());

  it("covers every application table while leaving platform tables to D1", async () => {
    const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations'`).all()).results;
    assert.deepEqual(Object.values(schema).map(getTableName).sort(), tables.map(row => row.name).sort());
  });

  for (const table of Object.values(schema)) {
    const name = getTableName(table);
    it(`matches migrated ${name} columns, scalar types and nullability`, async () => {
      const stored = (await db.prepare(`PRAGMA table_info(${name})`).all()).results;
      const columns = Object.values(getTableColumns(table));
      assert.deepEqual(columns.map(column => column.name).sort(), stored.map(column => column.name).sort());
      for (const column of columns) {
        const actual = stored.find(candidate => candidate.name === column.name);
        assert.equal(column.getSQLType().toUpperCase(), actual.type, `${name}.${column.name} type`);
        // SQLite reports TEXT PRIMARY KEY separately from its notnull flag.
        assert.equal(column.notNull, Boolean(actual.notnull || actual.pk), `${name}.${column.name} nullability`);
      }
    });
  }
});
