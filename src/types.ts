export type VariableType =
  | "string"
  | "number"
  | "boolean"
  | "device-path"
  | "serial-id"
  | "hostname"
  | "ip-address"
  | "url"
  | "secret";

export type PackageVariable = {
  name: string;
  label: string;
  description: string;
  type: VariableType;
  required: boolean;
  secret: boolean;
  example?: string;
};

export type ConfigFile = {
  path: string;
  role: string;
  content: string;
  public: boolean;
};

export type EditorValueSelection = {
  from: number;
  line: number;
  suggestedName: string;
  to: number;
  value: string;
};

export type EditorVariableReferenceSelection = {
  from: number;
  line: number;
  name: string;
  to: number;
};

// OrcaSlicer preset types. A companion asset now stores a real OrcaSlicer
// preset: its `content` is the raw preset JSON (the source of truth) and `kind`
// is the preset type. Legacy rows created before this used "slicer"/"filament"
// form profiles; they simply won't parse as presets and are left dormant.
export type CompanionAssetKind = "filament" | "machine" | "process";
export type PrinterConfigReference = { slug: string; title: string };

export type CompanionAsset = {
  id: string;
  kind: CompanionAssetKind;
  /** Optional legacy printer association. Profiles belong to the account. */
  printerId?: string | null;
  title: string;
  description: string;
  /** Raw OrcaSlicer preset JSON text — the source of truth for round-trips. */
  content: string;
  tags: string[];
  public: boolean;
  publicSlug?: string;
  publicUrl?: string;
  publishedAt?: string;
  printerConfig?: PrinterConfigReference | null;
  version: string;
  createdAt: string;
  updatedAt: string;
  /** Optional derived key/value snapshot; not authoritative (content wins). */
  structured?: Record<string, string>;
};

export type ConfigPackage = {
  id: string;
  name: string;
  title: string;
  version: string;
  printer: string;
  hardware: string[];
  tags: string[];
  description: string;
  variables: PackageVariable[];
  files: ConfigFile[];
  warnings: string[];
  companionAssetIds?: string[];
  publicCreatedAt?: string;
  publicSlug?: string;
  publicUpdatedAt?: string;
  publishedAt?: string;
  sourcePackageId?: string;
  tracksAppliedConfiguration?: boolean;
};

export type HistoryVersion = {
  id: number;
  previousId: number | null;
  message: string;
  source:
    | "web-editor"
    | "capture"
    | "recovery"
    | "public-package-install"
    | "fork"
    | "import"
    | "variable-extraction"
    | "package-release";
  createdAt: string;
  files: ConfigFile[];
};

export type PrinterState = {
  name: string;
  appliedAt?: string | null;
  latestVersionId: number;
  appliedVersionId: number;
  lastSeen: string;
};
