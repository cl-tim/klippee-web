export type ParameterValue = string | number | boolean;

export type ParameterField = {
  key: string;
  label: string;
  description?: string;
  group: string;
  type: "select" | "number" | "boolean" | "text";
  defaultValue: ParameterValue;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
};

export type ModelDefinition = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  category: "Channels" | "Holders" | "Hardware";
  file: string;
  accent: string;
  fields: ParameterField[];
  webUnsupported?: string;
  family?: "Underware 2.0" | "Monokini";
  variantKey?: string;
  draftIsPrintable?: boolean;
};

const select = (key: string, label: string, group: string, defaultValue: string, options: string[], description?: string): ParameterField => ({
  key, label, group, type: "select", defaultValue, options, description,
});

const number = (key: string, label: string, group: string, defaultValue: number, min: number, max: number, step = 1, description?: string): ParameterField => ({
  key, label, group, type: "number", defaultValue, min, max, step, description,
});

const boolean = (key: string, label: string, group: string, defaultValue: boolean, description?: string): ParameterField => ({
  key, label, group, type: "boolean", defaultValue, description,
});

const text = (key: string, label: string, group: string, defaultValue: string, description?: string): ParameterField => ({
  key, label, group, type: "text", defaultValue, description,
});

const part = select("Base_Top_or_Both", "Parts", "Output", "Both", ["Base", "Top", "Both"]);
const mounting = select("Mounting_Method", "Mounting method", "Mounting", "Threaded Snap Connector", [
  "Threaded Snap Connector", "Direct Multiboard Screw", "Direct Multipoint Screw", "Magnet", "Wood Screw", "Flat",
]);
const profile = select("Profile_Type", "Connection profile", "Fit", "Original", ["Original", "v2.5"]);
const strength = number("Additional_Holding_Strength", "Additional hold", "Fit", 0, 0, 1.5, 0.1);
const grid = number("Grid_Size", "Grid size", "Advanced", 25, 10, 50, 0.5, "25 mm for Multiboard; 28 mm for openGrid.");

const channelFields = (extras: ParameterField[] = []): ParameterField[] => [
  part,
  ...extras,
  mounting,
  number("Magnet_Diameter", "Magnet diameter", "Mounting", 4, 2, 20, 0.1),
  number("Magnet_Thickness", "Magnet thickness", "Mounting", 1.5, 0.4, 5, 0.1),
  profile,
  strength,
  boolean("Show_Attached", "Show assembled", "Output", false),
  grid,
];

const holderFields = (clamshellDefault: boolean): ParameterField[] => [
  select("Mounting_Style", "Mounting style", "Mounting", "Threaded Snap", ["Threaded Snap", "Multiconnect"]),
  select("Mounting_Surface", "Mounting surface", "Mounting", "openGrid", ["openGrid", "Multiboard", "Custom"]),
  number("Custom_Distance_Between_Slots", "Custom grid spacing", "Mounting", 28, 10, 60, 0.5),
  number("Internal_Depth", "Internal depth", "Item", 50, 0, 300, 0.1),
  number("Internal_Width", "Internal width", "Item", 60, 0, 400, 0.1),
  number("Internal_Height", "Internal height", "Item", 15, 0, 200, 0.1),
  boolean("ClamShell_Mode", "Two-piece clamshell", "Clamshell", clamshellDefault),
  number("total_item_width", "Overall item width", "Clamshell", 150, 1, 800, 0.1),
  number("item_slop", "Item clearance", "Clamshell", 0.3, 0, 5, 0.1),
  boolean("Backer_Only_Mode", "Backer only", "Output", false),
  boolean("frontCutout", "Front opening", "Cutouts", true),
  boolean("bottomCutout", "Bottom opening", "Cutouts", false),
  boolean("cordCutout", "Cord opening", "Cutouts", false),
  number("cordCutoutDiameter", "Cord diameter", "Cutouts", 10, 1, 50, 0.5),
  number("wallThickness", "Wall thickness", "Construction", 2, 0, 10, 0.1),
  number("baseThickness", "Base thickness", "Construction", 3, 0.4, 12, 0.1),
  number("Slop", "Thread clearance", "Fit", 0.075, 0, 0.5, 0.005),
  number("Force_Back_Thickness", "Backer thickness override", "Advanced", 0, 0, 15, 0.1),
];

const monokiniFields = (channel: ParameterField[], extras: ParameterField[] = []): ParameterField[] => [
  ...channel,
  number("Number_of_Cord_Cutouts", "Cord cutout count", "Cord cutouts", 0, 0, 20),
  select("Cord_Side_Cutouts", "Cord exits", "Cord cutouts", "Both Sides", ["Left Side", "Right Side", "Both Sides", "None", "Left Side Top", "Right Side Top"]),
  number("Cord_Cutout_Width", "Cutout width", "Cord cutouts", 12, 1, 50, 0.5),
  number("Distance_Between_Cutouts", "Cutout spacing", "Cord cutouts", 28, 1, 100, 0.5),
  number("Shift_Cutouts_Forward_or_Back", "Cutout offset", "Cord cutouts", 0, -100, 100, 0.5),
  boolean("Add_Label", "Add label", "Label", false),
  text("Text", "Label text", "Label", "Hands on Katie"),
  boolean("Text_Emboss", "Emboss text", "Label", false),
  ...extras,
  boolean("Decorative", "Decorative profile", "Advanced", false),
  number("Grip_Flare", "Grip flare", "Advanced", 0, 0, 15, 0.1),
  boolean("Show_Attached", "Show assembled", "Output", false),
  number("Grid_Size", "Grid size", "Advanced", 28, 10, 50, 0.5, "Monokini defaults to the 28 mm openGrid pitch."),
];

const monokiniModel = (definition: Omit<ModelDefinition, "family" | "draftIsPrintable">): ModelDefinition => ({
  ...definition,
  family: "Monokini",
  draftIsPrintable: true,
});

export const MODELS: ModelDefinition[] = [
  {
    id: "item-holder-clamshell", name: "Clamshell Item Holder", shortName: "Clamshell", category: "Holders", accent: "#f6b94b",
    description: "Two opposing holders aligned to Multiboard or openGrid, including threaded mount converters.",
    file: "Underware_Item_Holder_Clamshell_Style.scad", fields: holderFields(true),
  },
  {
    id: "item-holder", name: "Item Holder", shortName: "Holder", category: "Holders", accent: "#f28779",
    description: "A made-to-measure holder with configurable cutouts, walls and mounting backer.",
    file: "Underware_Item_Holder.scad", fields: holderFields(false),
  },
  {
    id: "i-channel", name: "Straight Channel", shortName: "I channel", category: "Channels", accent: "#73cbbf",
    description: "Straight two-piece cable channel with optional side exits and labels.",
    file: "Underware_I_Channel.scad", fields: channelFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 12),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 3, 1, 20),
      number("Number_of_Cord_Cutouts", "Cord cutout count", "Channel", 0, 0, 20),
      select("Cord_Side_Cutouts", "Cord exits", "Channel", "Both Sides", ["Left Side", "Right Side", "Both Sides", "None"]),
    ]),
  },
  {
    id: "l-channel", name: "L Channel", shortName: "L channel", category: "Channels", accent: "#71b8e8",
    description: "Right-angle channel with independently sized X and Y legs.", file: "Underware_L_Channel.scad",
    fields: channelFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 12),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
      number("L_Channel_Length_in_Units_X_Axis", "X leg units", "Channel", 1, 0, 20),
      number("L_Channel_Length_in_Units_Y_Axis", "Y leg units", "Channel", 1, 0, 20),
    ]),
  },
  {
    id: "t-channel", name: "T Intersection", shortName: "T channel", category: "Channels", accent: "#9e8ee6",
    description: "Three-way intersection for branching a channel run.", file: "Underware_T_Channel.scad",
    fields: channelFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 10),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
    ]),
  },
  {
    id: "x-channel", name: "X Intersection", shortName: "X channel", category: "Channels", accent: "#dd85bd",
    description: "Four-way crossing with independent horizontal and vertical widths.", file: "Underware_X_Channel.scad",
    fields: channelFields([
      number("Channel_X_Width_X_in_Units", "X width in units", "Channel", 1, 1, 10),
      number("Channel_Y_Width_in_Units", "Y width in units", "Channel", 1, 1, 10),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
    ]),
  },
  {
    id: "y-channel", name: "Y Branch", shortName: "Y channel", category: "Channels", accent: "#63c58c",
    description: "Symmetrical bifurcation with forward or turned exits.", file: "Underware_Y_Channel.scad",
    fields: channelFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
      number("Y_Units_Over", "Units outward", "Path", 1, 1, 10),
      number("Y_Units_Up", "Units forward", "Path", 1, 1, 10),
      select("Y_Output_Direction", "Exit direction", "Path", "Forward", ["Forward", "Turn"]),
      number("Y_Straight_Distance", "Straight lead", "Path", 12.5, 12.5, 100, 12.5),
    ]),
  },
  {
    id: "diagonal-channel", name: "Diagonal Channel", shortName: "Diagonal", category: "Channels", accent: "#e19b63",
    description: "Grid-aware diagonal transition with forward or ninety-degree exit.", file: "Underware_Diagonal_Channel.scad",
    fields: channelFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
      number("Units_Over", "Units across", "Path", 2, -10, 10),
      number("Units_Up", "Units forward", "Path", 2, -10, 10),
      select("Output_Direction", "Exit direction", "Path", "Turn", ["Forward", "Turn"]),
      number("Straight_Distance", "Straight lead", "Path", 25, 12.5, 100, 12.5),
    ]),
  },
  {
    id: "s-channel", name: "S Channel", shortName: "S channel", category: "Channels", accent: "#5fb3b3",
    description: "Smooth parallel offset between two channel runs.", file: "Underware_S_Channel.scad",
    fields: channelFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
      number("Units_Over", "Units across", "Path", 2, -10, 10),
      number("Units_Up", "Units forward", "Path", 2, -10, 10),
      number("Straight_Distance", "Straight lead", "Path", 12.5, 12.5, 100, 12.5),
    ]),
  },
  {
    id: "c-channel", name: "Curved Channel", shortName: "C channel", category: "Channels", accent: "#ef7f6d",
    description: "Quarter-turn curved channel with configurable radius.", file: "Underware_C_Channel.scad",
    fields: channelFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
      number("Curve_Radius_in_Units", "Curve radius in units", "Channel", 2, 1, 12),
    ]),
  },
  {
    id: "height-change", name: "Height Change", shortName: "Height change", category: "Channels", accent: "#d3b65c",
    description: "Straight channel that transitions between two internal heights.", file: "Underware_Height_Change_Channel.scad",
    fields: channelFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Internal_Height_1", "Start height", "Channel", 18, 12, 72, 6),
      number("Channel_Internal_Height_2", "End height", "Channel", 12, 12, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 3, 1, 20),
      number("Rise_Distance", "Transition distance", "Channel", 25, 12.5, 100, 12.5),
    ]),
  },
  {
    id: "transition", name: "Width + Height Transition", shortName: "Transition", category: "Channels", accent: "#6fa8dc",
    description: "Changes width and height across a straight run.", file: "Underware_Transition_Channel.scad",
    fields: channelFields([
      number("Channel_Width_in_Units_1", "Start width units", "Channel", 2, 1, 10),
      number("Channel_Width_in_Units_2", "End width units", "Channel", 1, 1, 10),
      number("Channel_Internal_Height_1", "Start height", "Channel", 18, 12, 72, 6),
      number("Channel_Internal_Height_2", "End height", "Channel", 12, 12, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 3, 1, 20),
      number("Rise_Distance", "Transition distance", "Channel", 25, 12.5, 100, 12.5),
      number("Rise_Offset", "Transition offset", "Channel", 0, -100, 100, 12.5),
    ]),
  },
  {
    id: "mitre", name: "Mitre Channel", shortName: "Mitre", category: "Channels", accent: "#a8bd68",
    description: "Inside and outside corner mitres for vertical changes.", file: "Underware_Mitre_Channel.scad",
    fields: [
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Internal_Height", "Internal height", "Channel", 12, 12, 72, 6),
      number("Length_of_Longest_Edge_1", "First edge length", "Channel", 75, 20, 400, 1),
      number("Length_of_Longest_Edge_2", "Second edge length", "Channel", 75, 20, 400, 1),
      grid,
    ],
  },
  {
    id: "connectors", name: "Threaded Snap Connectors", shortName: "Connectors", category: "Hardware", accent: "#f2b544",
    description: "Printable threaded snap connectors and Multiboard-compatible bolts.", file: "Underware_Connectors.scad",
    fields: [
      select("Show_Part", "Part", "Output", "Snap Connector", ["Snap Connector", "Bolts"]),
      number("Snap_Connector_Height", "Stand-off height", "Snap", 3, 0, 15, 0.1),
      number("Snap_Holding_Tolerance", "Holding scale", "Snap", 1, 0.5, 2, 0.05),
      number("Snap_Thread_Height", "Thread height", "Snap", 3.6, 1, 12, 0.1),
      boolean("Split_Printing", "Split for strength", "Output", false, "Disabled by default because unsplit geometry renders much faster in the browser."),
      number("Oct_Scaling", "Octagon scaling", "Fit", 1, 0.8, 1.2, 0.01),
    ],
  },
  {
    id: "keyholes", name: "Keyhole Mounts", shortName: "Keyholes", category: "Hardware", accent: "#dc7e8f",
    description: "Snap-backed keyhole adapters for Multiboard and openGrid.", file: "Underware_keyholes.scad",
    webUnsupported: "This upstream keyhole generator triggers a WebAssembly runtime failure. Use desktop OpenSCAD for printable keyhole mounts.",
    fields: [
      select("Mounting_Surface", "Surface", "Mounting", "Multiboard", ["Multiboard", "openGrid - Lite", "openGrid - Full"]),
      select("Show_Part", "Part", "Output", "Snap Keyhole", ["Snap Keyhole", "Keyhole Test"]),
      boolean("Split_Printing", "Split for strength", "Output", false, "Enable only for the final printable layout."),
      number("Snap_Connector_Height", "Stand-off height", "Mounting", 3, 0, 15, 0.1),
      number("distanceBetweenKeyholeEntranceCenters", "Keyhole centre spacing", "Keyhole", 144, 0, 500, 0.5),
      number("keyholeEntraceDiameter", "Entrance diameter", "Keyhole", 7.5, 1, 30, 0.1),
      number("keyholeSlotDiameter", "Slot diameter", "Keyhole", 4.1, 1, 20, 0.1),
    ],
  },
  {
    id: "hooks", name: "Hook + Groove Rack", shortName: "Hooks", category: "Hardware", accent: "#74b886",
    description: "Multi-groove rack with Multiconnect or threaded snap backers.", file: "hooksAndGroves.scad",
    webUnsupported: "This rack currently relies on geometry operations that crash the available OpenSCAD WebAssembly builds. Use desktop OpenSCAD for this model.",
    fields: [
      select("Mounting_Style", "Mounting style", "Mounting", "Threaded Snap", ["Threaded Snap", "Multiconnect"]),
      select("Mounting_Surface", "Mounting surface", "Mounting", "openGrid", ["openGrid", "Multiboard"]),
      number("Slot_Count", "Mount columns", "Mounting", 2, 1, 10),
      number("Number_of_Grooves", "Number of grooves", "Rack", 6, 2, 20, 2),
      number("Groove_Depth", "Groove depth", "Rack", 10, 1, 80, 0.5),
      number("Groove_Width", "Groove width", "Rack", 10, 1, 80, 0.5),
      number("Center_Post_Length", "Centre post length", "Rack", 20, 1, 120, 0.5),
      number("Hook_Depth", "Overall depth", "Construction", 25, 5, 120, 0.5),
      number("Snap_Thread_Height", "Thread height", "Fit", 3.6, 1, 12, 0.1),
      number("Slop", "Thread clearance", "Fit", 0.075, 0, 0.5, 0.005),
    ],
  },
  monokiniModel({
    id: "monokini-i-channel", variantKey: "i-channel", name: "Straight Channel", shortName: "I channel", category: "Channels", accent: "#55c7b3",
    description: "Monokini's simpler openGrid-first straight cable channel.", file: "monokini_I_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 12),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 1, 1, 20),
    ], [text("Channel_Separators", "Separator positions", "Advanced", "", "Comma-separated channel positions." )]),
  }),
  monokiniModel({
    id: "monokini-l-channel", variantKey: "l-channel", name: "L Channel", shortName: "L channel", category: "Channels", accent: "#62b7df",
    description: "Monokini openGrid right-angle channel with independently sized legs.", file: "monokini_L_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 12),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("L_Channel_Length_in_Units_X_Axis", "X leg units", "Channel", 1, 0, 20),
      number("L_Channel_Length_in_Units_Y_Axis", "Y leg units", "Channel", 1, 0, 20),
    ]),
  }),
  monokiniModel({
    id: "monokini-t-channel", variantKey: "t-channel", name: "T Intersection", shortName: "T channel", category: "Channels", accent: "#8d8bdf",
    description: "Monokini openGrid three-way channel with independent branch widths and lengths.", file: "monokini_T_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units_Bottom", "Bottom width units", "Channel", 1, 1, 10),
      number("Channel_Width_in_Units_Left", "Left width units", "Channel", 1, 1, 10),
      number("Channel_Width_in_Units_Right", "Right width units", "Channel", 1, 1, 10),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("T_Channel_Length_in_Units_Y_Axis", "Stem length units", "Channel", 1, 0, 20),
      number("T_Channel_Length_in_Units_X_Axis_Left", "Left length units", "Channel", 1, 0, 20),
      number("T_Channel_Length_in_Units_X_Axis_Right", "Right length units", "Channel", 1, 0, 20),
    ]),
  }),
  monokiniModel({
    id: "monokini-x-channel", variantKey: "x-channel", name: "X Intersection", shortName: "X channel", category: "Channels", accent: "#cd79b2",
    description: "Monokini openGrid four-way channel with independent leg lengths.", file: "monokini_X_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 10),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("X_Channel_Length_in_Units_Y_Axis_Bottom", "Bottom length units", "Channel", 1, 0, 20),
      number("X_Channel_Length_in_Units_Y_Axis_Top", "Top length units", "Channel", 1, 0, 20),
      number("X_Channel_Length_in_Units_X_Axis_Left", "Left length units", "Channel", 1, 0, 20),
      number("X_Channel_Length_in_Units_X_Axis_Right", "Right length units", "Channel", 1, 0, 20),
    ]),
  }),
  monokiniModel({
    id: "monokini-diagonal-channel", variantKey: "diagonal-channel", name: "Diagonal Channel", shortName: "Diagonal", category: "Channels", accent: "#db9457",
    description: "Monokini openGrid diagonal transition with straight runs at both ends.", file: "monokini_diagonal_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("Diagonal_Channel_Length_in_Units_Y_Axis_Bottom", "Bottom length units", "Path", 1, 0, 20),
      number("Diagonal_Channel_Length_in_Units_Y_Axis_Top", "Top length units", "Path", 1, 0, 20),
      number("Units_Over", "Units across", "Path", 2, -10, 10),
      number("Units_Up", "Units forward", "Path", 2, 1, 10),
    ]),
  }),
  monokiniModel({
    id: "monokini-s-channel", variantKey: "s-channel", name: "S Channel", shortName: "S channel", category: "Channels", accent: "#4caaa9",
    description: "Monokini openGrid parallel offset with straight runs at both ends.", file: "monokini_S_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("S_Channel_Length_in_Units_Y_Axis_Bottom", "Bottom length units", "Path", 1, 0, 20),
      number("S_Channel_Length_in_Units_Y_Axis_Top", "Top length units", "Path", 1, 0, 20),
      number("Units_Over", "Units across", "Path", 2, -10, 10),
      number("Units_Up", "Units forward", "Path", 2, 1, 10),
    ]),
  }),
  monokiniModel({
    id: "monokini-height-change", variantKey: "height-change", name: "Height Change", shortName: "Height change", category: "Channels", accent: "#c7a94f",
    description: "Monokini openGrid straight channel transitioning between two heights.", file: "monokini_I_height_change_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Internal_Height_1", "Start height", "Channel", 18, 10, 72, 6),
      number("Channel_Internal_Height_2", "End height", "Channel", 12, 10, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 3, 1, 20),
      number("Rise_Distance", "Transition distance", "Channel", 25, 1, 100, 1),
    ]),
  }),
  monokiniModel({
    id: "monokini-transition", variantKey: "transition", name: "Width + Height Transition", shortName: "Transition", category: "Channels", accent: "#639dd0",
    description: "Monokini openGrid width transition with a consistent internal height.", file: "monokini_I_width_change_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units_1", "Start width units", "Channel", 2, 1, 10),
      number("Channel_Width_in_Units_2", "End width units", "Channel", 1, 1, 10),
      number("Channel_Internal_Height", "Internal height", "Channel", 18, 10, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 3, 1, 20),
      number("Rise_Distance_Units", "Transition distance units", "Channel", 1, 1, 10),
    ]),
  }),
  monokiniModel({
    id: "monokini-mitre", variantKey: "mitre", name: "Mitre Channel", shortName: "Mitre", category: "Channels", accent: "#95ae59",
    description: "Monokini openGrid mitred corner with optional mirroring and added radius.", file: "monokini_mitre_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("L_Channel_Length_in_Units_X_Axis", "X leg units", "Channel", 1, 0, 20),
      number("L_Channel_Length_in_Units_Y_Axis", "Y leg units", "Channel", 1, 0, 20),
      boolean("Mirror_Channel", "Mirror channel", "Channel", false),
      number("Added_Radius", "Added radius", "Channel", 0, 0, 50, 0.5),
    ]),
  }),
  monokiniModel({
    id: "monokini-i-bridge", name: "Bridge Channel", shortName: "Bridge", category: "Channels", accent: "#66b6a8",
    description: "Monokini bridge channel for crossing another cable run at a different height.", file: "monokini_I_bridge_channel.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Internal_Height_1", "Approach height", "Channel", 22, 10, 72, 6),
      number("Channel_Internal_Height_2", "Bridge rise", "Channel", 22, 10, 72, 6),
      number("Channel_Bridge_Height", "Clearance below bridge", "Channel", 22, 10, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 1, 1, 20),
      boolean("Half_Bridge", "Half bridge", "Channel", false),
    ]),
  }),
  monokiniModel({
    id: "monokini-i-textured", name: "Textured Straight Channel", shortName: "Textured I", category: "Channels", accent: "#b27ac9",
    description: "Monokini straight channel with a generated surface texture.", file: "monokini_I_channel_tex.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 1, 1, 20),
      select("Texture_Type", "Texture", "Texture", "tri_grid", ["tri_grid", "hex_grid", "bricks", "checkers", "diamonds", "pyramids", "dots", "trunc_diamonds"]),
    ]),
  }),
  monokiniModel({
    id: "monokini-i-wood", name: "Wood-effect Straight Channel", shortName: "Wood I", category: "Channels", accent: "#b98961",
    description: "Monokini straight channel with its built-in wood-effect surface.", file: "monokini_I_channel_wood.scad",
    fields: monokiniFields([
      number("Channel_Width_in_Units", "Width in units", "Channel", 1, 1, 8),
      number("Channel_Total_Height", "Total height", "Channel", 22, 10, 72, 6),
      number("Channel_Length_Units", "Length in units", "Channel", 1, 1, 20),
    ]),
  }),
  monokiniModel({
    id: "monokini-text-label", name: "Text Label", shortName: "Text label", category: "Hardware", accent: "#e48aa5",
    description: "Standalone Monokini openGrid label plate.", file: "monokini_text_label.scad",
    fields: [
      number("Label_Width_in_Units", "Width in units", "Label", 1, 1, 12),
      number("Label_Length_Units", "Length in units", "Label", 1, 1, 20),
      boolean("Add_Label", "Add text", "Label", true),
      text("Text", "Label text", "Label", "Hands on Katie"),
      number("Text_size", "Text size", "Label", 10, 1, 40, 0.5),
      number("Text_Depth", "Text depth", "Label", 0.2, 0, 2, 0.2),
      boolean("Text_Emboss", "Emboss text", "Label", false),
      number("Grip_Flare", "Grip flare", "Advanced", 0, 0, 15, 0.1),
      number("Grid_Size", "Grid size", "Advanced", 28, 10, 50, 0.5),
    ],
  }),
];

export const MODEL_BY_ID = Object.fromEntries(MODELS.map((model) => [model.id, model]));

export function familyFor(model: ModelDefinition): "Underware 2.0" | "Monokini" {
  return model.family ?? "Underware 2.0";
}

export function variantKeyFor(model: ModelDefinition): string {
  return model.variantKey ?? model.id;
}

export function variantsFor(model: ModelDefinition): ModelDefinition[] {
  const key = variantKeyFor(model);
  return MODELS.filter((candidate) => variantKeyFor(candidate) === key);
}

const modelChoices = new Map<string, ModelDefinition>();
for (const model of MODELS) {
  const key = variantKeyFor(model);
  if (!modelChoices.has(key) || familyFor(model) === "Monokini") modelChoices.set(key, model);
}

export const MODEL_CHOICES = [...modelChoices.values()];

export function defaultsFor(model: ModelDefinition): Record<string, ParameterValue> {
  return Object.fromEntries(model.fields.map((field) => [field.key, field.defaultValue]));
}
