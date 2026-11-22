import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { drizzleDb, drizzleReadDb } from "./db";

vi.mock("drizzle-orm/d1", () => ({
  drizzle: vi.fn(() => ({ select: vi.fn(), selectDistinct: vi.fn() })),
}));

function session() {
  const batchSpy = vi.fn<(statements: D1PreparedStatement[]) => void>();
  return {
    prepare: vi.fn<D1DatabaseSession["prepare"]>(),
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      batchSpy(statements);
      return [];
    },
    batchSpy,
  };
}

describe("Drizzle D1 session adapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates statements and batches to each caller's session without reusing a client", async () => {
    const first = session(), second = session();
    drizzleReadDb(first);
    drizzleDb(second);
    const a = vi.mocked(drizzle).mock.calls[0][0];
    const b = vi.mocked(drizzle).mock.calls[1][0];
    expect(a).not.toBe(b);
    a.prepare("SELECT 1");
    b.prepare("SELECT 2");
    await a.batch([]);
    expect(first.prepare).toHaveBeenCalledExactlyOnceWith("SELECT 1");
    expect(second.prepare).toHaveBeenCalledExactlyOnceWith("SELECT 2");
    expect(first.batchSpy).toHaveBeenCalledExactlyOnceWith([]);
    expect(second.batchSpy).not.toHaveBeenCalled();
  });

  it("refuses driver operations that could bypass the existing session", () => {
    drizzleReadDb(session());
    const client = vi.mocked(drizzle).mock.calls[0][0];
    expect(() => client.exec("SELECT 1")).toThrow("existing D1 session");
    expect(() => client.dump()).toThrow("existing D1 session");
    expect(() => client.withSession("first-primary")).toThrow("existing D1 session");
  });
});
