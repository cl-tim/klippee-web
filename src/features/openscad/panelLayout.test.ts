import { describe, expect, it } from "vitest";
import {
  normalizeOpenScadPanelRatios,
  nudgeOpenScadPanelRatios,
  resizeOpenScadPanelWidths,
} from "./panelLayout";

describe("OpenSCAD panel layout", () => {
  it("normalizes saved panel proportions", () => {
    expect(normalizeOpenScadPanelRatios([2, 1, 1])).toEqual([0.5, 0.25, 0.25]);
    expect(normalizeOpenScadPanelRatios([1, 0, 1])).toBeNull();
    expect(normalizeOpenScadPanelRatios([1, 1])).toBeNull();
  });

  it("resizes the two panels adjacent to a divider", () => {
    expect(resizeOpenScadPanelWidths([400, 500, 400], 0, 80)).toEqual([480, 420, 400]);
    expect(resizeOpenScadPanelWidths([400, 500, 400], 1, -60)).toEqual([400, 440, 460]);
  });

  it("keeps every panel above its desktop minimum", () => {
    expect(resizeOpenScadPanelWidths([400, 500, 400], 0, 500)).toEqual([540, 360, 400]);
    expect(resizeOpenScadPanelWidths([400, 500, 400], 1, 500)).toEqual([400, 620, 280]);
  });

  it("supports keyboard nudging without collapsing a panel", () => {
    const nudged = nudgeOpenScadPanelRatios([1, 1, 1], 0, 0.04);
    expect(nudged[0]).toBeCloseTo(0.3733);
    expect(nudged[1]).toBeCloseTo(0.2933);
    expect(nudged[2]).toBeCloseTo(0.3333);
    const constrained = nudgeOpenScadPanelRatios([0.16, 0.68, 0.16], 1, 1);
    expect(constrained[2]).toBeCloseTo(0.16);
  });
});
