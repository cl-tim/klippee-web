import { createContext, useContext } from "react";
import type { PackageDraft, PrinterPublicationCandidate } from "../types";
import type { ConfigPackage, ConfigFile, EditorValueSelection } from "../../types";
import type { VariableValues } from "../../rendering";

export type PackageContextValue = {
  selectedPackage: ConfigPackage | null;
  selectedPackageId: string;
  selectedFile: ConfigFile | null;
  privatePackages: ConfigPackage[];
  privatePackageStatus: string;
  availablePackages: ConfigPackage[];
  filteredPackages: ConfigPackage[];
  registryQuery: string;
  registryTag: string;
  registryTags: string[];
  catalogStatus: string;
  packageDownloadUrl: string;
  browserZipAvailable: boolean;
  renderedFile: { content: string; path: string; role: string } | null;
  missingVariables: number;
  values: VariableValues;
  variableErrors: Record<string, string>;
  packageDraft: PackageDraft;
  bindStatus: string;
  buildStatus: string;
  publishStatus: string;
  downloadState: string;
  bindable: boolean;
  publishable: boolean;
  workspacePublishable: boolean;
  handleDownload: () => Promise<void>;
  selectPackage: (id: string) => void;
  selectPreviewFile: (path: string) => void;
  setRegistryQuery: (value: string) => void;
  setRegistryTag: (value: string) => void;
  updateVariable: (name: string, value: string) => void;
  updatePackageDraft: (field: keyof PackageDraft, value: string) => void;
  convertSelectionToVariable: (filePath: string, selection: EditorValueSelection, name: string) => boolean;
  buildPackageFromWorkspace: () => void;
  publishSelectedPackage: (acknowledgeSafetyWarnings?: boolean) => Promise<string | null>;
  publishWorkspacePackage: (
    draft: PackageDraft,
    candidate: PrinterPublicationCandidate,
    acknowledgeSafetyWarnings?: boolean,
  ) => Promise<string | null>;
  updatePublicPackageListing: (packageId: string, draft: PackageDraft) => Promise<boolean>;
  bindSelectedPackageToPrinter: () => void;
  unbindPackageFromPrinter: (packageId: string) => void;
  forgetDeletedPrivatePackage: (packageId: string) => void;
};

export const PackageContext = createContext<PackageContextValue | null>(null);

export function usePackageContext(): PackageContextValue {
  const context = useContext(PackageContext);
  if (!context) {
    throw new Error("usePackageContext must be used inside <PackageProvider>");
  }
  return context;
}
