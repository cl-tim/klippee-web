import { describe, expect, it } from "vitest";
import { maxD1JsonRemovePathsPerStatement } from "./constants";

describe("D1 SQL limits", () => {
  it("keeps json_remove calls within D1's 32-argument boundary", () => {
    const documentArgument = 1;

    expect(documentArgument + maxD1JsonRemovePathsPerStatement).toBe(32);
  });
});
