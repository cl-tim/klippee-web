import { describe, expect, it } from "vitest";
import { defaultOpenScadParameterValues, openScadDefinition, parseOpenScadParameters } from "./parameterParser";

describe("parseOpenScadParameters", () => {
  it("parses Customizer groups, ranges, options, booleans, and text", () => {
    const parameters = parseOpenScadParameters(`
/* [Shape] */
// Overall outside width.
// Measured in millimetres.
width = 40; // [10:0.5:100]
profile = "round"; // [round:Round,square:Square]
centered = true;
label = "Klippee"; // Text embossed on the model.
/* [Hidden] */
internal_value = 12;
`);

    expect(parameters).toHaveLength(4);
    expect(parameters[0]).toMatchObject({
      description: "Overall outside width. Measured in millimetres.",
      group: "Shape",
      key: "width",
      min: 10,
      max: 100,
      step: 0.5,
      type: "number",
    });
    expect(parameters[1].options).toEqual([
      { label: "Round", value: "round" },
      { label: "Square", value: "square" },
    ]);
    expect(parameters[2]).toMatchObject({ defaultValue: true, type: "boolean" });
    expect(parameters[3]).toMatchObject({ description: "Text embossed on the model.", type: "text" });
    expect(defaultOpenScadParameterValues(parameters)).toMatchObject({ width: 40, profile: "round", centered: true });
  });

  it("formats command-line definitions safely", () => {
    expect(openScadDefinition("label", 'A "quoted" label')).toBe('label="A \\"quoted\\" label"');
    expect(openScadDefinition("width", 25)).toBe("width=25");
  });
});
