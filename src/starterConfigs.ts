import type { ConfigFile, PackageVariable } from "./types";

export type StarterConfig = {
  description: string;
  files: ConfigFile[];
  id: string;
  license: string;
  sourceLabel: string;
  tags: string[];
  title: string;
  upstreamUrl: string;
  variables: PackageVariable[];
};

export const starterConfigs: StarterConfig[] = [
  {
    description:
      "A conservative two-file Cartesian Klipper starter with controller serial and motion limit variables ready for review.",
    files: [
      {
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
        path: "printer.cfg",
        public: true,
        role: "entrypoint",
      },
      {
        content: `[gcode_macro START_PRINT]
description: Minimal startup macro for review before first print
gcode:
  G90
  M117 Klippee starter config loaded

[gcode_macro END_PRINT]
description: Minimal shutdown macro for review before first print
gcode:
  M104 S0
  M140 S0
  M84
`,
        path: "macros/startup.cfg",
        public: true,
        role: "macro",
      },
    ],
    id: "generic-cartesian-klipper",
    license: "MIT",
    sourceLabel: "Klippee reviewed starter",
    tags: ["cartesian", "klipper", "starter"],
    title: "Generic Cartesian Klipper Starter",
    upstreamUrl: "https://klippee.xyz",
    variables: [
      {
        description: "Linux serial path for the printer controller board.",
        example: "/dev/serial/by-id/usb-Klipper_starter_mcu-if00",
        label: "MCU serial path",
        name: "mcu_serial",
        required: true,
        secret: false,
        type: "device-path",
      },
      {
        description: "Conservative starting maximum XY velocity in mm/s.",
        example: "150",
        label: "Maximum XY velocity",
        name: "max_velocity",
        required: true,
        secret: false,
        type: "number",
      },
    ],
  },
  {
    description:
      "A CoreXY-oriented starter that keeps machine-specific pins out while giving the workspace a reviewed include structure.",
    files: [
      {
        content: `[include macros/startup.cfg]

[mcu]
serial: \${KLIPPEE:mcu_serial}

[printer]
kinematics: corexy
max_velocity: \${KLIPPEE:max_velocity}
max_accel: 2500
max_z_velocity: 8
max_z_accel: 100

[virtual_sdcard]
path: ~/printer_data/gcodes
`,
        path: "printer.cfg",
        public: true,
        role: "entrypoint",
      },
      {
        content: `[gcode_macro START_PRINT]
description: Minimal CoreXY startup macro for review
gcode:
  G90
  M117 Klippee CoreXY starter loaded

[gcode_macro END_PRINT]
description: Minimal CoreXY shutdown macro for review
gcode:
  M104 S0
  M140 S0
  M84
`,
        path: "macros/startup.cfg",
        public: true,
        role: "macro",
      },
    ],
    id: "generic-corexy-klipper",
    license: "MIT",
    sourceLabel: "Klippee reviewed starter",
    tags: ["corexy", "klipper", "starter"],
    title: "Generic CoreXY Klipper Starter",
    upstreamUrl: "https://klippee.xyz",
    variables: [
      {
        description: "Linux serial path for the printer controller board.",
        example: "/dev/serial/by-id/usb-Klipper_corexy_mcu-if00",
        label: "MCU serial path",
        name: "mcu_serial",
        required: true,
        secret: false,
        type: "device-path",
      },
      {
        description: "Conservative starting maximum XY velocity in mm/s.",
        example: "200",
        label: "Maximum XY velocity",
        name: "max_velocity",
        required: true,
        secret: false,
        type: "number",
      },
    ],
  },
];
