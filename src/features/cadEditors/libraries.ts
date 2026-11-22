import { tabLabels } from "../../app/constants";
import gridfinityConstants from "./scad/gridfinity/gridfinity-constants.scad?raw";
import gridfinityRebuiltBaseplate from "./scad/gridfinity/gridfinity-rebuilt-baseplate.scad?raw";
import gridfinityRebuiltBins from "./scad/gridfinity/gridfinity-rebuilt-bins.scad?raw";
import gridfinityRebuiltLite from "./scad/gridfinity/gridfinity-rebuilt-lite.scad?raw";
import gridfinityRebuiltUtility from "./scad/gridfinity/gridfinity-rebuilt-utility.scad?raw";
import openGridSource from "./scad/opengrid/openGrid.scad?raw";
import {
  MODELS as exploredUnderwareModels,
  type ModelDefinition as ExploredUnderwareModel,
  type ParameterField,
  type ParameterValue,
} from "./underwareModels";

export type CadEditorKind = "gridfinity" | "opengrid" | "underware";

export type CadSourceFile = {
  name: string;
  source: string;
};

export type CadRenderParameter = ParameterValue | CadRenderParameter[];

export type CadComponentModel = {
  accent: string;
  category: string;
  description: string;
  family?: string;
  fields: ParameterField[];
  file: string;
  fixedValues?: Record<string, ParameterValue>;
  id: string;
  name: string;
  requiredFiles?: string[];
  renderParameters?: (values: Record<string, ParameterValue>) => Record<string, CadRenderParameter>;
  shortName: string;
};

export type CadEditorLibrary = {
  attribution: Array<{ label: string; url: string }>;
  description: string;
  id: CadEditorKind;
  models: CadComponentModel[];
  sourceFiles: CadSourceFile[];
  storageKey: string;
  title: string;
};

const number = (
  key: string,
  label: string,
  group: string,
  defaultValue: number,
  min: number,
  max: number,
  step = 1,
  description?: string,
): ParameterField => ({
  defaultValue,
  description,
  group,
  key,
  label,
  max,
  min,
  step,
  type: "number",
});

const boolean = (
  key: string,
  label: string,
  group: string,
  defaultValue: boolean,
  description?: string,
): ParameterField => ({
  defaultValue,
  description,
  group,
  key,
  label,
  type: "boolean",
});

const select = (
  key: string,
  label: string,
  group: string,
  defaultValue: string,
  options: string[],
  description?: string,
): ParameterField => ({
  defaultValue,
  description,
  group,
  key,
  label,
  options,
  type: "select",
});

const text = (
  key: string,
  label: string,
  group: string,
  defaultValue: string,
  description?: string,
): ParameterField => ({
  defaultValue,
  description,
  group,
  key,
  label,
  type: "text",
});

// The Gridfinity Rebuilt sources are bundled unmodified, so their enumerated
// Customizer values stay integers. Klippee shows readable labels and maps each
// one back to its upstream index before rendering.
const GRIDFINITY_HEIGHT_MODES = ["7 mm units", "Internal height (mm)", "External height (mm)"];
const GRIDFINITY_TAB_STYLES = ["Full", "Auto", "Left", "Centre", "Right", "None"];
const GRIDFINITY_BIN_HOLES = [
  "None",
  "Magnets",
  "Magnets and screws",
  "Magnets and screws (printable slit)",
];
const GRIDFINITY_PLATE_STYLES = ["Thin", "Weighted", "Skeletonized"];
const GRIDFINITY_PLATE_HOLES = ["None", "Countersink", "Counterbore"];

const GRIDFINITY_SHARED_FILES = ["gridfinity-rebuilt-utility.scad", "gridfinity-constants.scad"];

function upstreamIndex(options: string[], value: ParameterValue): number {
  const index = options.indexOf(String(value));
  return index < 0 ? 0 : index;
}

function gridfinityHeightFields(defaultHeight: number): ParameterField[] {
  return [
    select(
      "gridz_define",
      "Height measured in",
      "Size",
      GRIDFINITY_HEIGHT_MODES[0],
      GRIDFINITY_HEIGHT_MODES,
      "Choose what the height value below means.",
    ),
    number("gridz", "Height", "Size", defaultHeight, 1, 240, 0.5, "Units or millimetres, per the mode above"),
    boolean("enable_zsnap", "Snap to 7 mm", "Size", false, "Round the height up to the next 7 mm increment."),
  ];
}

function gridfinityBaseFields(): ParameterField[] {
  return [
    select("style_hole", "Base holes", "Base", GRIDFINITY_BIN_HOLES[0], GRIDFINITY_BIN_HOLES),
    number("div_base_x", "Base divisions across", "Base", 0, 0, 4, 1, "0 chooses automatically"),
    number("div_base_y", "Base divisions down", "Base", 0, 0, 4, 1, "0 chooses automatically"),
    number("length", "Grid pitch", "Base", 42, 20, 100, 0.5, "The Gridfinity standard is 42 mm."),
  ];
}

function gridfinityBinParameters(values: Record<string, ParameterValue>): Record<string, CadRenderParameter> {
  return {
    ...values,
    gridz_define: upstreamIndex(GRIDFINITY_HEIGHT_MODES, values.gridz_define),
    style_hole: upstreamIndex(GRIDFINITY_BIN_HOLES, values.style_hole),
    style_tab: upstreamIndex(GRIDFINITY_TAB_STYLES, values.style_tab),
  };
}

function gridfinityBaseplateParameters(values: Record<string, ParameterValue>): Record<string, CadRenderParameter> {
  return {
    ...values,
    style_hole: upstreamIndex(GRIDFINITY_PLATE_HOLES, values.style_hole),
    style_plate: upstreamIndex(GRIDFINITY_PLATE_STYLES, values.style_plate),
  };
}

const gridfinityModels: CadComponentModel[] = [
  {
    accent: "#67d8bd",
    category: "Storage",
    description: "The upstream Gridfinity Rebuilt bin, with equal compartments, label tabs, and scooped floors.",
    family: "Gridfinity Rebuilt",
    fields: [
      number("gridx", "Width", "Size", 2, 0.5, 16, 0.5, "Gridfinity units (42 mm each)"),
      number("gridy", "Depth", "Size", 1, 0.5, 16, 0.5, "Gridfinity units (42 mm each)"),
      ...gridfinityHeightFields(6),
      number("divx", "Columns", "Compartments", 1, 1, 12, 1),
      number("divy", "Rows", "Compartments", 1, 1, 12, 1),
      select("style_tab", "Label tab", "Compartments", GRIDFINITY_TAB_STYLES[1], GRIDFINITY_TAB_STYLES,
        "Tabs are dropped automatically below 3 units of height."),
      boolean("enable_scoop", "Scooped floor", "Compartments", true, "Adds the internal fillet that helps parts out."),
      boolean("enable_lip", "Stacking lip", "Construction", true),
      number("height_internal", "Internal height override", "Construction", 0, 0, 240, 0.5,
        "Millimetres; 0 uses the calculated height."),
      ...gridfinityBaseFields(),
    ],
    file: "gridfinity-rebuilt-bins.scad",
    id: "gridfinity-rebuilt-bin",
    name: "Gridfinity Rebuilt Bin",
    requiredFiles: ["gridfinity-rebuilt-bins.scad", ...GRIDFINITY_SHARED_FILES],
    renderParameters: gridfinityBinParameters,
    shortName: "Bin",
  },
  {
    accent: "#f6b94b",
    category: "Storage",
    description: "The upstream Lite bin, which hollows out the base to save filament and print time.",
    family: "Gridfinity Rebuilt",
    fields: [
      number("gridx", "Width", "Size", 2, 0.5, 16, 0.5, "Gridfinity units (42 mm each)"),
      number("gridy", "Depth", "Size", 2, 0.5, 16, 0.5, "Gridfinity units (42 mm each)"),
      ...gridfinityHeightFields(6),
      number("divx", "Columns", "Compartments", 2, 1, 12, 1),
      number("divy", "Rows", "Compartments", 2, 1, 12, 1),
      select("style_tab", "Label tab", "Compartments", GRIDFINITY_TAB_STYLES[1], GRIDFINITY_TAB_STYLES,
        "Tabs are dropped automatically below 3 units of height."),
      boolean("enable_lip", "Stacking lip", "Construction", true),
      ...gridfinityBaseFields(),
    ],
    file: "gridfinity-rebuilt-lite.scad",
    id: "gridfinity-rebuilt-lite-bin",
    name: "Gridfinity Rebuilt Lite Bin",
    requiredFiles: ["gridfinity-rebuilt-lite.scad", ...GRIDFINITY_SHARED_FILES],
    renderParameters: gridfinityBinParameters,
    shortName: "Lite bin",
  },
  {
    accent: "#71b8e8",
    category: "Foundation",
    description: "The upstream baseplate in thin, weighted, or skeletonized styles, with magnet and screw options.",
    family: "Gridfinity Rebuilt",
    fields: [
      number("gridx", "Width", "Size", 4, 0, 16, 1, "Gridfinity units; 0 fills the drawer width below."),
      number("gridy", "Depth", "Size", 4, 0, 16, 1, "Gridfinity units; 0 fills the drawer depth below."),
      number("distancex", "Drawer width", "Fit to drawer", 0, 0, 800, 1, "Millimetres; 0 ignores this."),
      number("distancey", "Drawer depth", "Fit to drawer", 0, 0, 800, 1, "Millimetres; 0 ignores this."),
      select("style_plate", "Plate style", "Construction", GRIDFINITY_PLATE_STYLES[2], GRIDFINITY_PLATE_STYLES),
      boolean("enable_magnet", "Magnet pockets", "Hardware", false),
      select("style_hole", "Screw holes", "Hardware", GRIDFINITY_PLATE_HOLES[0], GRIDFINITY_PLATE_HOLES),
      number("length", "Grid pitch", "Construction", 42, 20, 100, 0.5, "The Gridfinity standard is 42 mm."),
    ],
    file: "gridfinity-rebuilt-baseplate.scad",
    id: "gridfinity-rebuilt-baseplate",
    name: "Gridfinity Rebuilt Baseplate",
    requiredFiles: ["gridfinity-rebuilt-baseplate.scad", ...GRIDFINITY_SHARED_FILES],
    renderParameters: gridfinityBaseplateParameters,
    shortName: "Baseplate",
  },
];

const openGridFinishFields: ParameterField[] = [
  select("Chamfers", "Chamfers", "Edges", "Corners", ["Everywhere", "Corners", "None"]),
  boolean("Chamfer_Top_Left", "Top-left corner", "Edges", true),
  boolean("Chamfer_Top_Right", "Top-right corner", "Edges", true),
  boolean("Chamfer_Bottom_Left", "Bottom-left corner", "Edges", true),
  boolean("Chamfer_Bottom_Right", "Bottom-right corner", "Edges", true),
  boolean("Connector_Holes", "Connector holes", "Connectors", true),
  boolean("Connector_Holes_Top", "Top edge", "Connectors", true),
  boolean("Connector_Holes_Right", "Right edge", "Connectors", true),
  boolean("Connector_Holes_Bottom", "Bottom edge", "Connectors", true),
  boolean("Connector_Holes_Left", "Left edge", "Connectors", true),
];

const openGridScrewFields: ParameterField[] = [
  select("Screw_Mounting", "Screw layout", "Mounting", "Corners", [
    "Everywhere",
    "Corners",
    "By Row and Column",
    "Custom",
    "None",
  ]),
  number("Screw_Every_X_Rows", "Every X rows", "Mounting", 1, 1, 12, 1),
  number("Screw_Every_X_Columns", "Every X columns", "Mounting", 2, 1, 12, 1),
  text(
    "Screw_Custom_Positions",
    "Custom screw positions",
    "Mounting",
    "011110",
    "Read left-to-right, top-to-bottom; 1 adds a screw.",
  ),
  number("Screw_Diameter", "Screw diameter", "Mounting", 4.1, 1, 12, 0.1),
  number("Screw_Head_Diameter", "Head diameter", "Mounting", 7.2, 1, 18, 0.1),
  number("Screw_Head_Inset", "Head inset", "Mounting", 1, 0, 6, 0.1),
  boolean("Screw_Head_Is_CounterSunk", "Countersunk head", "Mounting", true),
  number("Screw_Head_CounterSunk_Degree", "Countersink angle", "Mounting", 90, 45, 135, 1),
];

const openGridStackFields: ParameterField[] = [
  number("Stack_Count", "Tiles in stack", "Print stack", 1, 1, 6, 1),
  select("Stacking_Method", "Separation method", "Print stack", "Interface Layer", [
    "Interface Layer",
    "Ironing - BETA",
  ]),
  number("Interface_Thickness", "Interface thickness", "Print stack", 0.4, 0.1, 1.2, 0.1),
  number("Interface_Separation", "Interface separation", "Print stack", 0.1, 0, 0.6, 0.05),
];

function openGridTileFields(kind: "Full" | "Lite"): ParameterField[] {
  return [
    number("Board_Width", "Width", "Tile", 2, 1, 12, 1, "openGrid units (28 mm by default)"),
    number("Board_Height", "Height", "Tile", 2, 1, 12, 1, "openGrid units (28 mm by default)"),
    number("Tile_Size", "Grid pitch", "Tile", 28, 20, 50, 0.5, "The openGrid standard is 28 mm."),
    kind === "Lite"
      ? number("Lite_Tile_Thickness", "Tile thickness", "Tile", 4, 2, 6.8, 0.1)
      : number("Tile_Thickness", "Tile thickness", "Tile", 6.8, 4, 12, 0.1),
    ...openGridFinishFields,
    ...openGridScrewFields,
    ...openGridStackFields,
  ];
}

const openGridModels: CadComponentModel[] = [
  {
    accent: "#67d8bd",
    category: "Tiles",
    description: "The lightweight tile from BlackjackDuck's openGrid generator, with real connector, chamfer, screw, and print-stack controls.",
    family: "openGrid",
    fields: openGridTileFields("Lite"),
    file: "openGrid.scad",
    fixedValues: { Fill_Space_Mode: "None", Full_or_Lite: "Lite" },
    id: "opengrid-lite-tile",
    name: "openGrid Lite Tile",
    requiredFiles: ["openGrid.scad"],
    shortName: "Lite tile",
  },
  {
    accent: "#71b8e8",
    category: "Tiles",
    description: "The full-thickness tile from BlackjackDuck's openGrid generator, including its mounting and edge options.",
    family: "openGrid",
    fields: openGridTileFields("Full"),
    file: "openGrid.scad",
    fixedValues: { Fill_Space_Mode: "None", Full_or_Lite: "Full" },
    id: "opengrid-full-tile",
    name: "openGrid Full Tile",
    requiredFiles: ["openGrid.scad"],
    shortName: "Full tile",
  },
  {
    accent: "#f6b94b",
    category: "Layouts",
    description: "Use the supplied fill-space generator to arrange complete tiles or clip a tile set to an available wall area.",
    family: "openGrid",
    fields: [
      select("Full_or_Lite", "Tile type", "Layout", "Lite", ["Lite", "Full"]),
      select("Fill_Space_Mode", "Fill mode", "Layout", "Complete Tiles Only", [
        "Complete Tiles Only",
        "Fill Available Space",
      ]),
      number("Space_Width", "Available width", "Layout", 168, 28, 1_000, 1, "Millimetres"),
      number("Space_Depth", "Available height", "Layout", 168, 28, 1_000, 1, "Millimetres"),
      number("Max_Tile_Width", "Maximum tile width", "Tile limits", 3, 1, 12, 1, "openGrid units"),
      number("Max_Tile_Depth", "Maximum tile height", "Tile limits", 3, 1, 12, 1, "openGrid units"),
      number("Tile_Spacing", "Spacing between tiles", "Tile limits", 5, 0, 25, 0.5, "Millimetres"),
      number("Tile_Size", "Grid pitch", "Tile limits", 28, 20, 50, 0.5, "The openGrid standard is 28 mm."),
      number("Tile_Thickness", "Full tile thickness", "Tile limits", 6.8, 4, 12, 0.1),
      number("Lite_Tile_Thickness", "Lite tile thickness", "Tile limits", 4, 2, 6.8, 0.1),
      ...openGridFinishFields,
      ...openGridScrewFields,
    ],
    file: "openGrid.scad",
    id: "opengrid-fill-space",
    name: "openGrid Fill-space Layout",
    requiredFiles: ["openGrid.scad"],
    shortName: "Fill-space layout",
  },
];

const underwareSources = {
  ...import.meta.glob("./scad/underware/*.scad", { eager: true, import: "default", query: "?raw" }),
  ...import.meta.glob("./scad/monokini/*.scad", { eager: true, import: "default", query: "?raw" }),
} as Record<string, string>;

const underwareSourceFiles = Object.entries(underwareSources).map(([path, source]) => ({
  name: path.split("/").slice(-1)[0] ?? path,
  source,
}));

function underwareModel(model: ExploredUnderwareModel): CadComponentModel {
  return {
    accent: model.accent,
    category: model.category,
    description: model.description,
    family: model.family ?? "Underware 2.0",
    fields: model.fields,
    file: model.file,
    id: model.id,
    name: model.name,
    shortName: model.shortName,
  };
}

export const cadEditorLibraries: Record<CadEditorKind, CadEditorLibrary> = {
  gridfinity: {
    attribution: [
      { label: "Gridfinity by Zack Freedman", url: "https://gridfinity.xyz/" },
      { label: "Gridfinity Rebuilt in OpenSCAD by kennetek", url: "https://github.com/kennetek/gridfinity-rebuilt-openscad" },
    ],
    description: "Generate accurate bins and baseplates with the Gridfinity Rebuilt OpenSCAD models.",
    id: "gridfinity",
    models: gridfinityModels,
    sourceFiles: [
      { name: "gridfinity-rebuilt-bins.scad", source: gridfinityRebuiltBins },
      { name: "gridfinity-rebuilt-lite.scad", source: gridfinityRebuiltLite },
      { name: "gridfinity-rebuilt-baseplate.scad", source: gridfinityRebuiltBaseplate },
      { name: "gridfinity-rebuilt-utility.scad", source: gridfinityRebuiltUtility },
      { name: "gridfinity-constants.scad", source: gridfinityConstants },
    ],
    storageKey: "klippee.cad-editor.gridfinity-rebuilt.v1",
    title: tabLabels.Gridfinity,
  },
  opengrid: {
    attribution: [
      { label: "openGrid design by David D.", url: "https://www.printables.com/@DavidD" },
      { label: "OpenSCAD by BlackjackDuck (Andy)", url: "https://makerworld.com/en/@BlackjackDuck" },
    ],
    description: "Generate real Full and Lite openGrid tiles using BlackjackDuck's supplied OpenSCAD model.",
    id: "opengrid",
    models: openGridModels,
    sourceFiles: [
      { name: "openGrid.scad", source: openGridSource },
    ],
    storageKey: "klippee.cad-editor.opengrid-blackjackduck.v1",
    title: tabLabels.OpenGrid,
  },
  underware: {
    attribution: [
      { label: "Underware 2.0 by Hands on Katie and BlackjackDuck", url: "https://handsonkatie.com/underware-2-0-the-made-to-measure-collection/" },
      { label: "Monokini openGrid channel models", url: "https://www.printables.com/model/1263973-monokini-underware-for-opengrid" },
    ],
    description: "Select a cable-management component, choose the Underware or Monokini design, and tune its fit before export.",
    id: "underware",
    models: exploredUnderwareModels.map(underwareModel),
    sourceFiles: underwareSourceFiles,
    storageKey: "klippee.cad-editor.underware.v1",
    title: tabLabels.Underware,
  },
};

export function defaultValuesFor(model: CadComponentModel): Record<string, ParameterValue> {
  return {
    ...Object.fromEntries(model.fields.map((field) => [field.key, field.defaultValue])),
    ...model.fixedValues,
  };
}

export function renderParametersFor(
  model: CadComponentModel,
  values: Record<string, ParameterValue>,
): Record<string, CadRenderParameter> {
  return {
    ...(model.renderParameters ? model.renderParameters(values) : values),
    ...model.fixedValues,
  };
}
