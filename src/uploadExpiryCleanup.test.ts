import { describe, expect, it } from "vitest";
import { removeExpiredDiagnosticUploads } from "../worker/routes/diagnosticUploads";
import { removeExpiredLogImprovementSubmissions } from "../worker/routes/logImprovementSubmissions";
import type { Env } from "../worker/types";

type CleanupRow = {
  expires_at: string;
  id: string;
  r2_key: string;
  size_bytes: number;
};

type FakeStatement = {
  bindings: unknown[];
  query: string;
  bind(...values: unknown[]): FakeStatement;
  run(): Promise<{ meta: { changes: number } }>;
};

function expiryBoundaryFixture(table: "diagnostic_uploads" | "log_improvement_submissions") {
  let row: CleanupRow | null = {
    expires_at: "2000-01-01T00:00:00.000Z",
    id: `${table}-pending`,
    r2_key: `${table}/${table}-pending.log.gz`,
    size_bytes: 0,
  };
  let objectExists = true;
  let finalizationSucceeded = false;

  const execute = async (statement: FakeStatement) => {
    const query = statement.query.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (query.startsWith(`update ${table} set size_bytes = ?`) && statement.bindings[0] === -1) {
      const current = row;
      if (current && current.size_bytes === 0 && current.expires_at <= new Date().toISOString()) {
        current.size_bytes = -1;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (query.startsWith(`delete from ${table}`)) {
      const current = row;
      if (current && statement.bindings[0] === current.id && statement.bindings[1] === current.r2_key) {
        row = null;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    return { meta: { changes: 0 } };
  };

  const prepare = (query: string): FakeStatement => {
    const statement: FakeStatement = {
      bindings: [],
      query,
      bind(...values) {
        statement.bindings = values;
        return statement;
      },
      run() {
        return execute(statement);
      },
    };
    return statement;
  };

  const session = {
    async batch(statements: FakeStatement[]) {
      await execute(statements[0]);
      const current = row;
      return [
        { meta: { changes: current?.size_bytes === -1 ? 1 : 0 }, results: [] },
        {
          meta: { changes: 0 },
          results: current && current.expires_at <= new Date().toISOString()
            ? [{ id: current.id, r2_key: current.r2_key }]
            : [],
        },
      ];
    },
    prepare,
  };

  const env = {
    BLOBS: {
      async delete() {
        // Cleanup has selected the expired reservation and deleted the old
        // object. Simulate the uploader putting bytes at that exact boundary.
        objectExists = false;
        objectExists = true;
        const current = row;
        if (current?.size_bytes === 0) {
          current.size_bytes = 123;
          current.expires_at = "2099-01-01T00:00:00.000Z";
          finalizationSucceeded = true;
        } else {
          // The real uploader sees a zero-row finalization and removes its put.
          objectExists = false;
        }
      },
    } as R2Bucket,
    DB: {
      withSession() {
        return session;
      },
    } as D1Database,
  } as Env;

  return {
    env,
    finalizationSucceeded: () => finalizationSucceeded,
    objectExists: () => objectExists,
    row: () => row,
  };
}

describe("expired upload reservation cleanup", () => {
  it.each([
    ["diagnostic", "diagnostic_uploads", removeExpiredDiagnosticUploads],
    ["improvement", "log_improvement_submissions", removeExpiredLogImprovementSubmissions],
  ] as const)("tombstones an expired %s reservation before crossing the R2 boundary", async (
    _label,
    table,
    cleanup,
  ) => {
    const fixture = expiryBoundaryFixture(table);

    expect(await cleanup(fixture.env)).toBe(1);
    expect(fixture.finalizationSucceeded()).toBe(false);
    expect(fixture.objectExists()).toBe(false);
    expect(fixture.row()).toBeNull();
  });
});
