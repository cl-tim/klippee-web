import type { ReactNode } from "react";
import { AppShellContext, type AppShellContextValue } from "./useAppShellContext";

export type { AppShellContextValue } from "./useAppShellContext";

export function AppShellProvider({ value, children }: { value: AppShellContextValue; children: ReactNode }) {
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}
