import { encodeBodies, encodedValuesEqual, type EncodedValue } from "./bodyCodec";

const legacyPrefix = "klippee.mvp.";
const accountPrefix = `${legacyPrefix}accounts.`;
const markerStoreName = "migrationMarkers";
const metadataStoreName = "accountMetadata";
const bodyStoreName = "contentBodies";
const retainedGlobalKeys = new Set(["appNavigationExpanded", "appNavigationPinned"]);

type MetadataRecord = { key: string; scope: string; value: EncodedValue; revision?: number };
type BodyRecord = { hash: string; scope: string; text: string };
type LegacyEntry = { storageKey: string; scope: string; key: string; raw: string; value: unknown };

function accountRecordFromKey(storageKey: string) {
  const suffix = storageKey.slice(accountPrefix.length);
  const separator = suffix.indexOf(":");
  if (separator < 0) return null;
  try {
    return { key: suffix.slice(separator + 1), scope: decodeURIComponent(suffix.slice(0, separator)) };
  } catch {
    return null;
  }
}

function parsedLegacyValue(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function getLegacyEntries(activeScope: string): LegacyEntry[] {
  const entries: LegacyEntry[] = [];
  for (const storageKey of Object.keys(localStorage)) {
    if (storageKey.startsWith(accountPrefix)) {
      const parsed = accountRecordFromKey(storageKey);
      if (!parsed || parsed.scope !== activeScope) continue;
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) entries.push({ storageKey, ...parsed, raw, value: parsedLegacyValue(raw) });
      continue;
    }
    if (!storageKey.startsWith(legacyPrefix)) continue;
    const key = storageKey.slice(legacyPrefix.length);
    if (retainedGlobalKeys.has(key)) continue;
    const raw = localStorage.getItem(storageKey);
    if (raw !== null) entries.push({ storageKey, scope: "legacy-quarantine", key: `legacy:${key}`, raw, value: raw });
  }
  return entries;
}

async function hashText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function migrateLegacyStorage(database: IDBDatabase, activeScope: string) {
  const entries = getLegacyEntries(activeScope);
  const prepared = await Promise.all(entries.map(async (entry) => ({
    ...entry,
    encoded: entry.scope === "legacy-quarantine" ? { value: entry.value, bodies: new Map<string, string>() } : await encodeBodies(entry.value, entry.key),
    conflictKey: `legacy-conflict:${entry.scope}:${entry.key}:${await hashText(entry.raw)}`,
  })));
  const candidateScopes = new Set([activeScope, "legacy-quarantine"]);
  const safeRemovals = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([markerStoreName, metadataStoreName, bodyStoreName], "readwrite");
    let callbackError: Error | null = null;
    const markerStore = transaction.objectStore(markerStoreName);
    const metadataStore = transaction.objectStore(metadataStoreName);
    const bodyStore = transaction.objectStore(bodyStoreName);
    const markersRequest = markerStore.getAll();
    const abort = (cause: unknown) => {
      callbackError = cause instanceof Error ? cause : new Error("Could not migrate saved workspace data.");
      try { transaction.abort(); } catch { /* the transaction may already be aborting */ }
    };
    markersRequest.onsuccess = () => {
      try {
        const marked = new Set((markersRequest.result as Array<{ scope: string }>).map((marker) => marker.scope));
        for (const scope of candidateScopes) {
          if (!marked.has(scope) && (scope === activeScope || prepared.some((entry) => entry.scope === scope))) {
            markerStore.put({ scope, version: 1 });
          }
        }
        for (const item of prepared) {
          const existingRequest = metadataStore.get([item.scope, item.key]);
          existingRequest.onsuccess = () => {
            try {
              const existing = existingRequest.result as MetadataRecord | undefined;
              const encodedValue = item.encoded.value;
              if (!existing || encodedValuesEqual(existing.value, encodedValue)) {
                if (!existing) metadataStore.put({ key: item.key, scope: item.scope, revision: 1, value: encodedValue } satisfies MetadataRecord);
                for (const [hash, text] of item.encoded.bodies) bodyStore.put({ hash, scope: item.scope, text } satisfies BodyRecord);
                safeRemovals.add(item.storageKey);
                return;
              }

              // A newer owner record already exists. Archive the untouched legacy
              // bytes instead of replacing either version or dropping the source.
              const conflictRequest = metadataStore.get(["legacy-quarantine", item.conflictKey]);
              conflictRequest.onsuccess = () => {
                try {
                  const archived = conflictRequest.result as MetadataRecord | undefined;
                  if (!archived) {
                    metadataStore.put({ key: item.conflictKey, scope: "legacy-quarantine", revision: 1, value: item.raw } satisfies MetadataRecord);
                    safeRemovals.add(item.storageKey);
                  } else if (archived.value === item.raw) {
                    safeRemovals.add(item.storageKey);
                  }
                } catch (cause) {
                  abort(cause);
                }
              };
            } catch (cause) {
              abort(cause);
            }
          };
        }
      } catch (cause) {
        abort(cause);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(callbackError ?? transaction.error ?? new Error("Legacy workspace migration failed."));
    transaction.onerror = () => reject(callbackError ?? transaction.error ?? new Error("Legacy workspace migration failed."));
  });

  for (const entry of entries) {
    if (safeRemovals.has(entry.storageKey) && localStorage.getItem(entry.storageKey) === entry.raw) {
      localStorage.removeItem(entry.storageKey);
    }
  }
}
