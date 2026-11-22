import { describe, expect, it } from "vitest";
import { sanitizeVariableValuesForStorage } from "./printerShared";

describe("sanitizeVariableValuesForStorage", () => {
  it("fails closed for valid non-object legacy JSON shapes", () => {
    expect(sanitizeVariableValuesForStorage(null)).toEqual({});
    expect(sanitizeVariableValuesForStorage([])).toEqual({});
    expect(sanitizeVariableValuesForStorage("legacy")).toEqual({});
  });

  it("keeps finite scalar values and removes invalid or secret entries", () => {
    expect(sanitizeVariableValuesForStorage({
      api_token: "host-only",
      beacon_serial: "/dev/serial/by-id/beacon",
      enabled: true,
      invalid_name: Number.POSITIVE_INFINITY,
      machine_identity: "package-secret",
      nullable: null,
    }, new Set(["machine_identity"]))).toEqual({
      beacon_serial: "/dev/serial/by-id/beacon",
      enabled: true,
      nullable: null,
    });
  });
});
