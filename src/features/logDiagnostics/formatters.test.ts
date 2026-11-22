import { describe, expect, it } from "vitest";
import { formatBinaryBytes } from "../../app/format";
import {
  formatDuration,
  formatEventTime,
  formatUploadAge,
  numericField,
} from "./formatters";

describe("diagnostic formatters", () => {
  it("formats byte counts using compact binary units", () => {
    expect(formatBinaryBytes(900)).toBe("900 B");
    expect(formatBinaryBytes(1_536)).toBe("1.5 KiB");
    expect(formatBinaryBytes(2.5 * 1024 * 1024)).toBe("2.5 MiB");
  });

  it("formats upload ages across minute, hour, and day boundaries", () => {
    const now = Date.parse("2026-07-24T12:00:00Z");
    expect(formatUploadAge("2026-07-24T11:59:45Z", now)).toBe("just now");
    expect(formatUploadAge("2026-07-24T11:42:00Z", now)).toBe("18m ago");
    expect(formatUploadAge("2026-07-24T08:00:00Z", now)).toBe("4h ago");
    expect(formatUploadAge("2026-07-22T12:00:00Z", now)).toBe("2d ago");
  });

  it("formats relative diagnostic times and durations", () => {
    expect(formatEventTime(null)).toBe("Unknown");
    expect(formatEventTime(12.3456)).toBe("T+12.346s");
    expect(formatDuration(42.2)).toBe("42s");
    expect(formatDuration(125)).toBe("2m 5s");
  });

  it("accepts only finite numeric telemetry fields", () => {
    expect(numericField(12)).toBe(12);
    expect(numericField(Number.NaN)).toBeNull();
    expect(numericField("12")).toBeNull();
  });
});
