import type { ReactNode } from "react";
import { PackageContext, type PackageContextValue } from "./usePackageContext";

export type { PackageContextValue } from "./usePackageContext";

export function PackageProvider({ value, children }: { value: PackageContextValue; children: ReactNode }) {
  return <PackageContext.Provider value={value}>{children}</PackageContext.Provider>;
}
