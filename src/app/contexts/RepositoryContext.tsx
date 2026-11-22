import type { ReactNode } from "react";
import { RepositoryContext, type RepositoryContextValue } from "./useRepositoryContext";

export type { RepositoryContextValue } from "./useRepositoryContext";

export function RepositoryProvider({ value, children }: { value: RepositoryContextValue; children: ReactNode }) {
  return <RepositoryContext.Provider value={value}>{children}</RepositoryContext.Provider>;
}
