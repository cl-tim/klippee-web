export type PrinterCatalogOption = {
  id: string;
  make: string;
  model: string;
  name: string;
  source: "catalog" | "custom";
  starterConfigId?: string;
  tags: string[];
};

export const orcaPrinterCatalog: PrinterCatalogOption[] = [
  {
    id: "generic-klipper-cartesian",
    make: "",
    model: "Cartesian Klipper",
    name: "Cartesian Klipper",
    source: "catalog",
    starterConfigId: "generic-cartesian-klipper",
    tags: ["cartesian", "klipper", "starter"],
  },
  {
    id: "generic-klipper-corexy",
    make: "",
    model: "CoreXY Klipper",
    name: "CoreXY Klipper",
    source: "catalog",
    starterConfigId: "generic-corexy-klipper",
    tags: ["corexy", "klipper", "starter"],
  },
  {
    id: "generic-klipper-bedslinger",
    make: "",
    model: "Bedslinger Klipper",
    name: "Bedslinger Klipper",
    source: "catalog",
    starterConfigId: "generic-cartesian-klipper",
    tags: ["bedslinger", "cartesian", "klipper"],
  },
  {
    id: "custom-printer",
    make: "Custom",
    model: "Custom",
    name: "Custom printer",
    source: "custom",
    tags: ["manual"],
  },
];
