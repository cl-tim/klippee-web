import { describe, expect, it } from "vitest";
import { deriveScopedAnalysis } from "./scopedAnalysis";
import type { KlippyLogAnalysis } from "./types";

function analysisFixture(): KlippyLogAnalysis {
  return {
    findings: [
      { detail: "MCU stopped responding.", id: "mcu-communication-loss", session: 1, severity: "critical", title: "MCU communication loss" },
      { detail: "Sensor reading out of range.", id: "adc-out-of-range", session: 2, severity: "critical", title: "ADC out of range" },
    ],
    incidents: [
      { anchor: { line: 40, text: "shutdown" }, session: 1 },
      { anchor: { line: 90, text: "shutdown" }, session: 2 },
    ],
    lineCount: 500,
    prints: [
      { fileName: "a.gcode", session: 1, startLine: 10 },
      { fileName: "b.gcode", session: 2, startLine: 60 },
    ],
    sessions: [
      { endLine: 50, number: 1, shutdownReason: "Lost communication with MCU 'mcu'", startLine: 1 },
      { endLine: 120, number: 2, shutdownReason: "ADC out of range", startLine: 51 },
    ],
    shutdownDumps: [
      { line: 45, session: 1 },
      { line: 100, session: 2 },
      { line: 80, session: 2 },
    ],
    summary: { detail: "combined", session: null, title: "Combined", tone: "clue" },
  } as unknown as KlippyLogAnalysis;
}

describe("deriveScopedAnalysis", () => {
  it("passes through combined results when every session is in scope", () => {
    const analysis = analysisFixture();
    const scoped = deriveScopedAnalysis(analysis, "all");

    expect(scoped.sessions).toBe(analysis.sessions);
    expect(scoped.findings).toBe(analysis.findings);
    expect(scoped.incidents).toBe(analysis.incidents);
    expect(scoped.prints).toBe(analysis.prints);
    expect(scoped.summary).toBe(analysis.summary);
    expect(scoped.lineCount).toBe(500);
  });

  it("sorts shutdown dumps newest-first even in the combined scope", () => {
    const scoped = deriveScopedAnalysis(analysisFixture(), "all");
    expect(scoped.shutdownDumps.map((dump) => [dump.session, dump.line])).toEqual([
      [2, 100],
      [2, 80],
      [1, 45],
    ]);
  });

  it("filters every collection to the selected session", () => {
    const scoped = deriveScopedAnalysis(analysisFixture(), "1");

    expect(scoped.sessions.map((session) => session.number)).toEqual([1]);
    expect(scoped.findings.map((finding) => finding.id)).toEqual(["mcu-communication-loss"]);
    expect(scoped.incidents.map((incident) => incident.session)).toEqual([1]);
    expect(scoped.prints.map((print) => print.fileName)).toEqual(["a.gcode"]);
    expect(scoped.shutdownDumps.map((dump) => dump.line)).toEqual([45]);
  });

  it("counts the lines covered by the selected session, not the whole log", () => {
    expect(deriveScopedAnalysis(analysisFixture(), "1").lineCount).toBe(50);
    expect(deriveScopedAnalysis(analysisFixture(), "2").lineCount).toBe(70);
  });

  it("rebuilds the summary from the scoped session so the conclusion matches the scope", () => {
    const scoped = deriveScopedAnalysis(analysisFixture(), "1");
    expect(scoped.summary).not.toEqual(analysisFixture().summary);
    expect(scoped.summary.session).toBe(1);
  });
});
