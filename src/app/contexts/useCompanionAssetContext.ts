import { createContext, useContext } from "react";
import type { CompanionAssetDraft, CompanionAssetImport } from "../types";
import type { CompanionAsset } from "../../types";

export type CompanionAssetContextValue = {
  companionAssets: CompanionAsset[];
  companionAssetDraft: CompanionAssetDraft;
  companionAssetStatus: string;
  editingCompanionAssetId: string | null;
  selectedCompanionAssetId: string;
  linkedCompanionAssets: CompanionAsset[];
  assignCompanionAssetsToPrinter: (printerId: string, ids: string[]) => Promise<void>;
  deleteCompanionAsset: (id: string) => Promise<boolean>;
  importCompanionAssets: (inputs: CompanionAssetImport[]) => Promise<void>;
  loadCompanionAssetForEdit: (id: string) => void;
  startNewCompanionAsset: (kind: CompanionAsset["kind"], printerId?: string | null) => void;
  updateCompanionAssetDraft: (
    field: keyof CompanionAssetDraft,
    value: string,
  ) => void;
  updateCompanionAssetStructured: (field: string, value: string) => void;
  linkSelectedCompanionAssetToPackage: () => void;
  publishSelectedCompanionAsset: () => Promise<void>;
  saveCompanionAsset: () => Promise<void>;
  setSelectedCompanionAssetId: (id: string) => void;
};

export const CompanionAssetContext = createContext<CompanionAssetContextValue | null>(null);

export function useCompanionAssetContext(): CompanionAssetContextValue {
  const context = useContext(CompanionAssetContext);
  if (!context) {
    throw new Error("useCompanionAssetContext must be used inside <CompanionAssetProvider>");
  }
  return context;
}
