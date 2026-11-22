import { clearAccountStorageDatabaseForTests, openAccountStorage } from "./storage/accountStorage";

const legacyPrefix = "klippee.mvp.";
const accountPrefix = `${legacyPrefix}accounts.`;

export type AccountStorageStatus = {
  error: string | null;
  flush: () => Promise<void>;
  pending: number;
  retryable: boolean;
  retry: () => Promise<void>;
  getSnapshot: () => { error: string | null; pending: number; retryable: boolean };
  subscribe: (listener: () => void) => () => void;
};

export type AccountStorage = {
  hasStored: (key: string) => boolean;
  loadStored: <T>(key: string, fallback: T) => T;
  saveStored: <T>(key: string, value: T) => void;
  setAndPersist: <T>(setter: (value: T) => void, key: string, value: T) => void;
  status: AccountStorageStatus;
  dispose: () => Promise<void>;
};

const hydratedTestAccess = new Map<string, AccountStorage>();

function loadJson<T>(storageKey: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Return the browser key for data owned by one account or anonymous workspace. */
export function accountStorageKey(userId: string | null, key: string) {
  const ownerScope = userId === null ? "anonymous" : `user:${userId}`;
  return `${accountPrefix}${encodeURIComponent(ownerScope)}:${key}`;
}

export async function createAccountStorage(userId: string | null): Promise<AccountStorage> {
  const opened = await openAccountStorage(ownerScopeFor(userId));
  const { hasStored, loadStored, saveStored, status } = opened;
  const storage: AccountStorage = {
    hasStored,
    loadStored,
    saveStored,
    setAndPersist<T>(setter: (value: T) => void, key: string, value: T) {
      setter(value);
      saveStored(key, value);
    },
    status,
    dispose: opened.dispose,
  };
  if (import.meta.env.MODE === "test") hydratedTestAccess.set(ownerScopeFor(userId), storage);
  return storage;
}

export function readHydratedAccountStorageForTests<T>(userId: string | null, key: string, fallback: T): T | undefined {
  const storage = hydratedTestAccess.get(ownerScopeFor(userId));
  return storage?.hasStored(key) ? storage.loadStored(key, fallback) : storage ? fallback : undefined;
}

export async function resetAccountStorageForTests() {
  await Promise.all([...hydratedTestAccess.values()].map((storage) => storage.dispose().catch(() => undefined)));
  hydratedTestAccess.clear();
  await clearAccountStorageDatabaseForTests();
}

export function createMemoryOnlyAccountStorage(userId: string | null, reason: unknown): AccountStorage {
  const scope = ownerScopeFor(userId);
  const encodedScope = encodeURIComponent(scope);
  const prefix = `${accountPrefix}${encodedScope}:`;
  const values = new Map<string, unknown>();
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      const raw = window.localStorage.getItem(key);
      if (raw === null) continue;
      try { values.set(name, JSON.parse(raw) as unknown); } catch { values.set(name, raw); }
    }
  } catch { /* source remains untouched; this session starts with a visible memory-only warning */ }
  const fallbackError = `Local browser storage could not open. This session is using memory only, so edits may not survive reload. ${reason instanceof Error ? reason.message : ""}`.trim();
  const snapshot = { error: fallbackError, pending: 0, retryable: false };
  let dirty = false;
  const preventMemoryLossOnUnload = (event: BeforeUnloadEvent) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", preventMemoryLossOnUnload);
  const status: AccountStorageStatus = {
    error: fallbackError,
    pending: 0,
    retryable: false,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    flush: async () => { throw new Error(fallbackError); },
    retry: async () => { throw new Error(fallbackError); },
  };
  return {
    hasStored: (key) => values.has(key),
    loadStored: <T>(key: string, fallback: T) => values.has(key) ? values.get(key) as T : fallback,
    saveStored: (key, value) => { values.set(key, value); dirty = true; },
    setAndPersist<T>(setter: (value: T) => void, key: string, value: T) {
      setter(value);
      values.set(key, value);
      dirty = true;
    },
    status,
    dispose: async () => { window.removeEventListener("beforeunload", preventMemoryLossOnUnload); },
  };
}

export function ownerScopeFor(userId: string | null) {
  return userId === null ? "anonymous" : `user:${userId}`;
}

/** Harmless device-wide interface preferences remain shared on this browser. */
export function loadGlobalStored<T>(key: string, fallback: T): T {
  return loadJson(`${legacyPrefix}${key}`, fallback);
}

export function saveGlobalStored<T>(key: string, value: T) {
  try { window.localStorage.setItem(`${legacyPrefix}${key}`, JSON.stringify(value)); } catch { /* optional device preference */ }
}
