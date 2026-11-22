import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useAccountStorage } from "../contexts/useAccountStorage";

/**
 * `useState` over an AccountStorage key: the initial value is read from
 * storage once on mount and every write persists, so call sites cannot forget
 * the `saveStored` pairing. The setter has a stable identity and supports
 * updater functions (resolved against the freshest written value, mirroring
 * the synchronous-ref pattern of the tracked workspace setters).
 *
 * Only for simple single-key state. Composite multi-key writes keep going
 * through their dedicated helpers (commitWorkspaceState / activatePrinter).
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const { loadStored, saveStored } = useAccountStorage();
  const [value, setValue] = useState<T>(() => loadStored(key, initial));
  // Freshest written value; lets consecutive updater-form writes in one event
  // handler compose without waiting for a re-render.
  const valueRef = useRef(value);
  const setAndSave = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const next = typeof action === "function"
      ? (action as (current: T) => T)(valueRef.current)
      : action;
    valueRef.current = next;
    setValue(next);
    saveStored(key, next);
  }, [key, saveStored]);
  return [value, setAndSave];
}
