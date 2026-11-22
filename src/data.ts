import type { ConfigPackage, HistoryVersion, PrinterState } from "./types";

export const packages: ConfigPackage[] = [
  {
    id: "klipper-cartesian-starter",
    name: "klipper-cartesian-starter",
    title: "Klipper Cartesian Starter",
    version: "2026.05.21",
    printer: "Generic Cartesian Klipper printer",
    hardware: ["cartesian", "starter", "klipper"],
    tags: ["starter", "cartesian", "klipper"],
    description:
      "A small reviewed starter package for launch validation and first-run rendering. Review all motion, heater, and pin settings against the actual printer before applying.",
    variables: [
      {
        name: "mcu_serial",
        label: "MCU serial path",
        description: "Linux serial path for the printer controller board.",
        type: "device-path",
        required: true,
        secret: false,
        example: "/dev/serial/by-id/usb-Klipper_starter_mcu-if00",
      },
      {
        name: "max_velocity",
        label: "Maximum XY velocity",
        description: "Conservative starting maximum velocity in mm/s.",
        type: "number",
        required: true,
        secret: false,
        example: "150",
      },
    ],
    files: [
      {
        path: "printer.cfg",
        role: "entrypoint",
        public: true,
        content: `[include macros/startup.cfg]

[mcu]
serial: \${KLIPPEE:mcu_serial}

[printer]
kinematics: cartesian
max_velocity: \${KLIPPEE:max_velocity}
max_accel: 1500
max_z_velocity: 8
max_z_accel: 100

[virtual_sdcard]
path: ~/printer_data/gcodes
`,
      },
      {
        path: "macros/startup.cfg",
        role: "macro",
        public: true,
        content: `[gcode_macro START_PRINT]
description: Minimal startup macro placeholder
gcode:
  G90
  M117 Klippee starter config loaded

[gcode_macro END_PRINT]
description: Minimal shutdown macro placeholder
gcode:
  M104 S0
  M140 S0
  M84
`,
      },
    ],
    warnings: [
      "Starter packages are not printer-specific. Review controller serial, motion limits, heater settings, and pin assignments before applying.",
      "This package intentionally omits hardware pin and heater sections until they are selected for a real printer.",
    ],
  },
];

export const initialHistory: HistoryVersion[] = [];

export const initialPrinter: PrinterState = {
  name: "Unlinked printer",
  latestVersionId: 0,
  appliedVersionId: 0,
  lastSeen: "never",
};
