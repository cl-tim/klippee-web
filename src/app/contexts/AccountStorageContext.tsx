import { useEffect, useRef, useState, type ReactNode } from "react";
import { EmptyPanel } from "../../components/common";
import { createAccountStorage, createMemoryOnlyAccountStorage, type AccountStorage } from "../../storage";
import { AccountStorageContext } from "./useAccountStorage";

export function AccountStorageProvider({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string | null;
}) {
  const [state, setState] = useState<{
    userId: string | null;
    storage: Awaited<ReturnType<typeof createAccountStorage>> | null;
    loading: boolean;
  }>({ userId, storage: null, loading: true });
  const activeStorageRef = useRef<AccountStorage | null>(null);

  useEffect(() => {
    let active = true;
    activeStorageRef.current = null;
    void createAccountStorage(userId).then((storage) => {
      if (active) {
        activeStorageRef.current = storage;
        setState({ userId, storage, loading: false });
      } else {
        void storage.dispose().catch(() => undefined);
      }
    }).catch((error: unknown) => {
      if (active) {
        const storage = createMemoryOnlyAccountStorage(userId, error);
        activeStorageRef.current = storage;
        setState({ userId, storage, loading: false });
      }
    });
    return () => {
      active = false;
      const storage = activeStorageRef.current;
      activeStorageRef.current = null;
      if (storage) void storage.dispose().catch(() => undefined);
    };
  }, [userId]);

  if (state.userId !== userId || state.loading || !state.storage) {
    return (
      <main className="workbench">
        <EmptyPanel title="Loading saved drafts" />
      </main>
    );
  }

  return (
    <AccountStorageContext.Provider value={state.storage}>{children}</AccountStorageContext.Provider>
  );
}
