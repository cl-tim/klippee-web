import type { OpenScadSourceFile } from "./types";

const scratchSource = `// OpenSCAD scratch file
// Drop .scad files into the source panel or paste your model here.

cube([40, 40, 10], center = true);
`;

export function createDefaultOpenScadFiles(): OpenScadSourceFile[] {
  return [{ engine: "openscad", name: "model.scad", source: scratchSource }];
}
