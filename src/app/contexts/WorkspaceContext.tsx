import type { ReactNode } from "react";
import { WorkspaceContext, type WorkspaceContextValue } from "./useWorkspaceContext";

export type { WorkspaceContextValue } from "./useWorkspaceContext";

export function WorkspaceProvider({ value, children }: { value: WorkspaceContextValue; children: ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
