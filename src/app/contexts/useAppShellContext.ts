import { createContext, useContext } from "react";
import type { AuthUser, Tab } from "../types";

export type AppShellContextValue = {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  protectedDataPending: boolean;
  protectedTabLocked: boolean;
  authChecked: boolean;
  authStatus: string;
  authUser: AuthUser | null;
  cloudStatus: string;
  loginOpen: boolean;
  setLoginOpen: (open: boolean) => void;
  logout: () => Promise<void>;
};

export const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShellContext(): AppShellContextValue {
  const context = useContext(AppShellContext);
  if (!context) {
    throw new Error("useAppShellContext must be used inside <AppShellProvider>");
  }
  return context;
}
