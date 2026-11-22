import { describe, expect, it } from "vitest";
import { describeSession, formatSessionLabel } from "./sessionLabels";

describe("diagnostic session labels", () => {
  it("labels the beginning and latest detected sessions in file order", () => {
    const sessions = [
      { number: 1, reason: "printer start", wallTime: "Thu Jul 23 09:17:19 2026" },
      { number: 2, reason: "printer start", wallTime: "Thu Jul 23 09:18:36 2026" },
      { number: 3, reason: "printer start", wallTime: "Thu Jul 23 10:17:18 2026" },
    ];

    expect(formatSessionLabel(sessions, 1)).toBe("Session 1 · earliest detected");
    expect(formatSessionLabel(sessions, 2)).toBe("Session 2");
    expect(formatSessionLabel(sessions, 3)).toBe("Session 3 · latest detected");
  });

  it("calls out a log that begins partway through an existing session", () => {
    const sessions = [
      { number: 1, reason: "start of file", wallTime: "" },
      { number: 2, reason: "printer start", wallTime: "Thu Jul 23 10:17:18 2026" },
    ];

    expect(describeSession(sessions, 1)).toBe("log starts mid-session");
    expect(formatSessionLabel(sessions, 2)).toBe("Session 2 · latest detected");
  });

  it("labels a single complete session without implying an ordering", () => {
    const sessions = [{ number: 1, reason: "printer start", wallTime: "Thu Jul 23 10:17:18 2026" }];
    expect(formatSessionLabel(sessions, 1)).toBe("Session 1 · only detected session");
  });
});
