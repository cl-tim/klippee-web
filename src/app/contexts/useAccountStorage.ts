import { createContext, useContext, useSyncExternalStore } from "react";
import type { AccountStorage } from "../../storage";

export const AccountStorageContext = createContext<AccountStorage | null>(null);

export function useAccountStorage(): AccountStorage {
  const context = useContext(AccountStorageContext);
  if (!context) {
    throw new Error("useAccountStorage must be used inside <AccountStorageProvider>");
  }
  return context;
}

export function useAccountStorageStatus() {
  const storage = useAccountStorage();
  const snapshot = useSyncExternalStore(storage.status.subscribe, storage.status.getSnapshot, storage.status.getSnapshot);
  return { ...snapshot, flush: storage.status.flush, retry: storage.status.retry };
}
