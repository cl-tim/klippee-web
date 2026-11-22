import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PrinterRecord } from "../types";
import type { PrinterCatalogOption } from "../../orcaPrinterCatalog";

export type PrinterContextValue = {
  printers: PrinterRecord[];
  selectedPrinter: PrinterRecord | null;
  selectedPrinterId: string;
  creatingPrinter: boolean;
  switchingPrinterId: string;
  printerStatus: string;
  printerLoadFailed: boolean;
  printerPickerOpen: boolean;
  pendingDeletePrinterId: string;
  printerDetailsEditorId: string;
  printerDetailsDraft: { description: string; name: string };
  addPrinterDraft: () => void;
  loadPrintersFromCloud: () => Promise<void>;
  selectPrinter: (id: string) => Promise<void>;
  startPrinterDraftFromCatalog: (
    option: PrinterCatalogOption,
    details?: { description?: string; name?: string },
  ) => void;
  requestDeletePrinter: (id: string) => void;
  cancelDeletePrinter: () => void;
  confirmDeletePrinter: (id: string) => void;
  openPrinterDetailsEditor: (id: string) => void;
  closePrinterDetailsEditor: () => void;
  savePrinterDetails: () => void;
  updatePrinterDetails: (id: string, details: { description: string; name: string }) => Promise<boolean>;
  setPrinterPickerOpen: (open: boolean) => void;
  setPrinterDetailsDraft: Dispatch<SetStateAction<{ description: string; name: string }>>;
};

export const PrinterContext = createContext<PrinterContextValue | null>(null);

export function usePrinterContext(): PrinterContextValue {
  const context = useContext(PrinterContext);
  if (!context) {
    throw new Error("usePrinterContext must be used inside <PrinterProvider>");
  }
  return context;
}
