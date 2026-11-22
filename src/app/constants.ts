import type { Tab } from "./types";

export const primaryTabs = [
  "Printers",
  "Setup",
  "Slicer",
  "Registry",
  "Diagnostics",
  "Gridfinity",
  "OpenGrid",
  "Underware",
] as const;

export const tabPaths: Record<Tab, string> = {
  Diagnostics: "/log-diagnostics",
  Gridfinity: "/gridfinity",
  OpenGrid: "/opengrid",
  Printers: "/printers",
  Registry: "/shared-configs",
  Setup: "/klipper-configs",
  Slicer: "/slicer",
  Underware: "/opengrid-underware",
};

export const pathTabs = new Map<string, Tab>([
  ["/", "Setup"],
  ...Object.entries(tabPaths).map(([tab, path]) => [path, tab as Tab] as const),
]);

export const tabLabels: Record<Tab, string> = {
  Slicer: "Orca Workspace",
  Printers: "Printers",
  Registry: "Shared Configs",
  Diagnostics: "Log Diagnostics",
  Gridfinity: "Gridfinity Editor",
  OpenGrid: "OpenGrid Editor",
  Setup: "Klipper Workspace",
  Underware: "OpenGrid Underware Editor",
};

export const protectedTabs = new Set<Tab>(["Setup", "Slicer", "Printers"]);

export const maxImportFiles = 64;
export const maxImportedConfigFileBytes = 256_000;
// Mirrors the Worker's bounded public render response before JSON/ZIP copies.
export const maxRenderedPackageBytes = 1_024_000;

export const communityRiskWarnings = [
  "Applying custom configuration may damage hardware, create unsafe motion or heating behavior, or void your printer warranty.",
  "Community packages are not tested, certified, or endorsed by Klippee or the printer manufacturer.",
  "Only publish, install, or sync configs you can read and understand; verify pins, thermistors, limits, and safety settings against your exact machine.",
];
