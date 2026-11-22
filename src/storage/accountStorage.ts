import { decodeBodies, encodeBodies, encodedValuesEqual, findBodyHashes, type EncodedValue } from "./bodyCodec";
import { migrateLegacyStorage } from "./migration";

const databaseName = "klippee-browser-storage";
const databaseVersion = 1;
const metadataStoreName = "accountMetadata";
const bodyStoreName = "contentBodies";
const migrationStoreName = "migrationMarkers";

type MetadataRecord = { key: string; scope: string; value: EncodedValue; revision?: number };
type BodyRecord = { hash: string; scope: string; text: string };

export type OpenedAccountStorage = {
  hasStored: (key: string) => boolean;
  loadStored: <T>(key: string, fallback: T) => T;
  saveStored: <T>(key: string, value: T) => void;
  dispose: () => Promise<void>;
  status: {
    error: string | null;
    flush: () => Promise<void>;
    pending: number;
    retryable: boolean;
    retry: () => Promise<void>;
    getSnapshot: () => { error: string | null; pending: number; retryable: boolean };
    subscribe: (listener: () => void) => () => void;
  };
};

export async function clearAccountStorageDatabaseForTests() {
  if (!globalThis.indexedDB) return;
  const database = await openDatabase();
  const transaction = database.transaction([metadataStoreName, bodyStoreName, migrationStoreName], "readwrite");
  transaction.objectStore(metadataStoreName).clear();
  transaction.objectStore(bodyStoreName).clear();
  transaction.objectStore(migrationStoreName).clear();
  await transactionDone(transaction);
  database.close();
}

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("This browser does not support local workspace storage."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(metadataStoreName, { keyPath: ["scope", "key"] });
      database.createObjectStore(bodyStoreName, { keyPath: ["scope", "hash"] });
      database.createObjectStore(migrationStoreName, { keyPath: "scope" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Could not open local workspace storage."));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Local workspace storage is busy in another tab. Close other Klippee tabs and reload."));
    };
  });
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local workspace storage request failed."));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Local workspace storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Local workspace storage transaction failed."));
  });
}

function storageError(error: unknown) {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "Browser storage is full. Your current edits remain open, but Klippee could not save them on this device. Free browser storage space and retry.";
  }
  return error instanceof Error ? error.message : "Klippee could not save this workspace on this device.";
}

function asError(value: unknown, fallback: string) {
  return value instanceof Error || value instanceof DOMException ? value : new Error(fallback);
}

export async function openAccountStorage(scope: string): Promise<OpenedAccountStorage> {
  const database = await openDatabase();
  try {
    await migrateLegacyStorage(database, scope);
    const { records, bodies } = await readScopeData(database, scope);
    const values = new Map(records.map((record) => [record.key, decodeBodies(record.value, bodies)]));
    const revisions = new Map(records.map((record) => [record.key, record.revision ?? 0]));
    return createMemoryFacade(database, scope, values, revisions);
  } catch (error) {
    database.close();
    throw error;
  }
}

async function readScopeData(database: IDBDatabase, scope: string) {
  const range = IDBKeyRange.bound([scope, ""], [scope, "\uffff"]);
  const transaction = database.transaction([metadataStoreName, bodyStoreName], "readonly");
  const recordsRequest = transaction.objectStore(metadataStoreName).getAll(range);
  const bodiesRequest = transaction.objectStore(bodyStoreName).getAll(range);
  const [records, bodies] = await Promise.all([
    requestValue(recordsRequest) as Promise<MetadataRecord[]>,
    requestValue(bodiesRequest) as Promise<BodyRecord[]>,
  ]);
  await transactionDone(transaction);
  return { records, bodies: new Map(bodies.map((body) => [body.hash, body.text])) };
}

type SaveJob = { key: string; value: unknown };

function createMemoryFacade(database: IDBDatabase, scope: string, values: Map<string, unknown>, revisions: Map<string, number>): OpenedAccountStorage {
  let error: string | null = null;
  let queue = Promise.resolve();
  let inFlight = 0;
  let drainScheduled = false;
  const listeners = new Set<() => void>();
  const pendingJobs = new Map<string, SaveJob>();
  const failedJobs = new Map<string, SaveJob>();
  let closed = false;
  let snapshot: { error: string | null; pending: number; retryable: boolean } = { error, pending: 0, retryable: false };

  const emit = () => {
    snapshot = { error, pending: pendingJobs.size + inFlight, retryable: failedJobs.size > 0 && !error?.startsWith("Another tab saved a newer workspace.") };
    listeners.forEach((listener) => listener());
  };

  async function persist(batch: SaveJob[]) {
    const encodedBatch = await Promise.all(batch.map((job) => encodeBodies(job.value, job.key)));
    const transaction = database.transaction([metadataStoreName, bodyStoreName], "readwrite");
    const done = transactionDone(transaction);
    const metadata = transaction.objectStore(metadataStoreName);
    const bodyStore = transaction.objectStore(bodyStoreName);
    let callbackError: Error | null = null;
    const updatedRevisions = new Map<string, number>();
    const abort = (reason: Error) => {
      callbackError = asError(reason, "Could not write the local workspace transaction.");
      try { transaction.abort(); } catch { /* the transaction may already be aborting */ }
    };
    try {
      const revisionsAtStart = new Map(batch.map((job) => [job.key, revisions.get(job.key) ?? 0]));
      const noOpKeys = new Set<string>();
      let remainingReads = batch.length;
      const commitBatch = () => {
        try {
          for (let index = 0; index < batch.length; index += 1) {
            const job = batch[index];
            const encoded = encodedBatch[index];
            if (noOpKeys.has(job.key)) continue;
            for (const [hash, text] of encoded.bodies) bodyStore.put({ hash, scope, text } satisfies BodyRecord);
            metadata.put({ key: job.key, scope, revision: (revisionsAtStart.get(job.key) ?? 0) + 1, value: encoded.value } satisfies MetadataRecord);
          }
          if (noOpKeys.size === batch.length) return;
          const scopeRange = IDBKeyRange.bound([scope, ""], [scope, "\uffff"]);
          const metadataRequest = metadata.getAll(scopeRange);
          metadataRequest.onsuccess = () => {
            try {
              const referenced = new Set<string>();
              for (const record of metadataRequest.result as MetadataRecord[]) findBodyHashes(record.value, referenced);
              const keysRequest = bodyStore.getAllKeys(scopeRange);
              keysRequest.onsuccess = () => {
                try {
                  for (const key of keysRequest.result) {
                    if (!Array.isArray(key)) continue;
                    const hash = String(key[1]);
                    if (!referenced.has(hash)) bodyStore.delete(key);
                  }
                } catch (cause) {
                  abort(asError(cause, "Could not reclaim old local file bodies."));
                }
              };
            } catch (cause) {
              abort(asError(cause, "Could not scan local workspace metadata."));
            }
          };
        } catch (cause) {
          abort(asError(cause, "Could not write the local workspace transaction."));
        }
      };

      for (const job of batch) {
        const request = metadata.get([scope, job.key]);
        request.onsuccess = () => {
          try {
            const current = request.result as MetadataRecord | undefined;
            const currentRevision = current?.revision ?? 0;
            const encoded = encodedBatch[batch.indexOf(job)];
            const sameValue = current !== undefined && encodedValuesEqual(current.value, encoded.value);
            if (currentRevision !== (revisionsAtStart.get(job.key) ?? 0) && !sameValue) {
              abort(new Error("Another tab saved a newer workspace. Your edits remain open in this tab but cannot be saved safely. Copy them somewhere safe before reloading."));
              return;
            }
            if (sameValue) {
              noOpKeys.add(job.key);
              updatedRevisions.set(job.key, currentRevision);
            } else {
              updatedRevisions.set(job.key, currentRevision + 1);
            }
            remainingReads -= 1;
            if (remainingReads === 0) commitBatch();
          } catch (cause) {
            abort(asError(cause, "Could not check the current workspace revision."));
          }
        };
      }
    } catch (cause) {
      abort(asError(cause, "Could not prepare the local workspace transaction."));
    }
    try {
      await done;
    } catch (cause) {
      throw callbackError ?? cause;
    }
    for (const job of batch) revisions.set(job.key, updatedRevisions.get(job.key) ?? (revisions.get(job.key) ?? 0) + 1);
  }

  function scheduleDrain() {
    if (drainScheduled || closed || pendingJobs.size === 0) return;
    drainScheduled = true;
    queue = queue.then(async () => {
      drainScheduled = false;
      if (pendingJobs.size === 0 || closed) return;
      const batch = [...pendingJobs.values()];
      pendingJobs.clear();
      inFlight += 1;
      emit();
      try {
        await persist(batch);
        for (const job of batch) {
          if (!pendingJobs.has(job.key)) failedJobs.delete(job.key);
        }
        if (failedJobs.size === 0) error = null;
      } catch (cause) {
        error = storageError(cause);
        for (const job of batch) failedJobs.set(job.key, pendingJobs.get(job.key) ?? job);
      } finally {
        inFlight -= 1;
        emit();
        scheduleDrain();
      }
    });
  }

  async function flush() {
    while (drainScheduled || pendingJobs.size > 0 || inFlight > 0) {
      scheduleDrain();
      await queue;
    }
    if (failedJobs.size) throw new Error(error ?? "Local workspace storage has unsaved changes.");
  }

  async function retry() {
    if (error?.startsWith("Another tab saved a newer workspace.")) throw new Error(error);
    for (const [key, job] of failedJobs) if (!pendingJobs.has(key)) pendingJobs.set(key, job);
    emit();
    scheduleDrain();
    await flush();
  }

  const status = {
    get error() { return error; },
    flush,
    get pending() { return snapshot.pending; },
    get retryable() { return snapshot.retryable; },
    retry,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const preventLossOnUnload = (event: BeforeUnloadEvent) => {
    if (snapshot.pending === 0 && !snapshot.error) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", preventLossOnUnload);

  return {
    hasStored: (key) => values.has(key),
    loadStored<T>(key: string, fallback: T): T {
      return values.has(key) ? values.get(key) as T : fallback;
    },
    saveStored<T>(key: string, value: T) {
      if (closed) return;
      values.set(key, value);
      pendingJobs.set(key, { key, value });
      emit();
      scheduleDrain();
    },
    async dispose() {
      window.removeEventListener("beforeunload", preventLossOnUnload);
      try { await flush(); } finally {
        closed = true;
        database.close();
      }
    },
    status,
  };
}
