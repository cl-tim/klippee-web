import type { ReactNode } from "react";
import { CompanionAssetContext, type CompanionAssetContextValue } from "./useCompanionAssetContext";

export type { CompanionAssetContextValue } from "./useCompanionAssetContext";

export function CompanionAssetProvider({
  value,
  children,
}: {
  value: CompanionAssetContextValue;
  children: ReactNode;
}) {
  return <CompanionAssetContext.Provider value={value}>{children}</CompanionAssetContext.Provider>;
}
