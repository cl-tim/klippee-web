import type { ReactNode } from "react";
import { PrinterContext, type PrinterContextValue } from "./usePrinterContext";

export type { PrinterContextValue } from "./usePrinterContext";

export function PrinterProvider({ value, children }: { value: PrinterContextValue; children: ReactNode }) {
  return <PrinterContext.Provider value={value}>{children}</PrinterContext.Provider>;
}
