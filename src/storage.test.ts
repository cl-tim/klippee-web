import { describe, expect, it, vi } from "vitest";
import { accountStorageKey, createAccountStorage } from "./storage";

async function database() {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("klippee-browser-storage", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function allRecords<T>(storeName: string): Promise<T[]> {
  const db = await database();
  const transaction = db.transaction(storeName, "readonly");
  const records = await new Promise<T[]>((resolve, reject) => {
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return records;
}

describe("account browser storage", () => {
  it("isolates authenticated and anonymous workspaces", async () => {
    const firstUser = await createAccountStorage("user/a");
    const secondUser = await createAccountStorage("user-b");
    const anonymous = await createAccountStorage(null);

    expect(firstUser.hasStored("workspaceContent")).toBe(false);
    firstUser.saveStored("workspaceContent", "first-user-secret");
    secondUser.saveStored("workspaceContent", "second-user-secret");
    anonymous.saveStored("workspaceContent", "anonymous-draft");
    await Promise.all([firstUser.status.flush(), secondUser.status.flush(), anonymous.status.flush()]);

    const hydratedFirstUser = await createAccountStorage("user/a");
    expect(hydratedFirstUser.loadStored("workspaceContent", "missing")).toBe("first-user-secret");
    expect(hydratedFirstUser.hasStored("workspaceContent")).toBe(true);
    expect(secondUser.loadStored("workspaceContent", "missing")).toBe("second-user-secret");
    expect(anonymous.loadStored("workspaceContent", "missing")).toBe("anonymous-draft");
    expect(accountStorageKey("user/a", "workspaceContent")).not.toBe(accountStorageKey(null, "workspaceContent"));
    expect(accountStorageKey("a", "b.c")).not.toBe(accountStorageKey("a.b", "c"));
  });

  it("migrates active account data losslessly and quarantines unowned legacy data", async () => {
    const original = {
      content: "private historical file body",
      path: "printer.cfg",
      public: false,
      role: "printer",
    };
    localStorage.setItem(accountStorageKey("user-a", "history"), JSON.stringify([{ files: [original], id: 1 }]));
    localStorage.setItem("klippee.mvp.workspaceContent", JSON.stringify("unknown-owner-secret"));

    const storage = await createAccountStorage("user-a");
    expect(storage.loadStored("history", [])).toEqual([{ files: [original], id: 1 }]);
    expect(localStorage.getItem(accountStorageKey("user-a", "history"))).toBeNull();
    expect(localStorage.getItem("klippee.mvp.workspaceContent")).toBeNull();
    expect(await allRecords<{ scope: string; key: string; value: unknown }>("accountMetadata")).toContainEqual(
      expect.objectContaining({ key: "legacy:workspaceContent", scope: "legacy-quarantine", value: '"unknown-owner-secret"' }),
    );
    await storage.status.flush();
  });

  it("stores repeated configuration strings once per account and reclaims bodies after replacement", async () => {
    const storage = await createAccountStorage("user-a");
    const shared = "[heater_bed]\ntemperature: 60\n";
    storage.saveStored("history", [{ files: [{ content: shared, path: "printer.cfg" }] }]);
    storage.saveStored("printers", [{ workspaceDraftFiles: [{ content: shared, path: "printer.cfg" }] }]);
    storage.saveStored("workspaceContent", shared);
    storage.saveStored("workspaceDrafts", { "printer.cfg": shared });
    storage.saveStored("companionAssets", [{ content: shared, id: "asset-1" }]);
    storage.saveStored("openScadWorkspace", { files: [{ name: "main.scad", source: shared }] });
    await storage.status.flush();

    const records = await allRecords<{ scope: string; hash: string; text: string }>("contentBodies");
    expect(records.filter((record) => record.scope === "user:user-a" && record.text === shared)).toHaveLength(1);
    expect(storage.loadStored<Array<{ files: Array<{ content: string }> }>>("history", [])[0].files[0].content).toBe(shared);

    storage.saveStored("history", []);
    storage.saveStored("printers", []);
    storage.saveStored("workspaceContent", "");
    storage.saveStored("workspaceDrafts", {});
    storage.saveStored("companionAssets", []);
    storage.saveStored("openScadWorkspace", { files: [], mainFile: "", parameterValues: {} });
    await storage.status.flush();
    const remaining = await allRecords<{ scope: string; text: string }>("contentBodies");
    expect(remaining.some((record) => record.scope === "user:user-a" && record.text === shared)).toBe(false);
  });

  it("keeps user objects that resemble internal reference nodes and preserves unusual keys", async () => {
    const storage = await createAccountStorage("user-a");
    const value = Object.create(null) as Record<string, unknown>;
    value.__klippeeStorageNode = "body";
    value.hash = "not-a-content-address";
    Object.defineProperty(value, "__proto__", { enumerable: true, value: "ordinary data" });
    storage.saveStored("arbitraryValue", value);
    await storage.status.flush();

    const reopened = await createAccountStorage("user-a");
    const loaded = reopened.loadStored<Record<string, unknown>>("arbitraryValue", {});
    expect(loaded.__klippeeStorageNode).toBe("body");
    expect(loaded.hash).toBe("not-a-content-address");
    expect(Object.prototype.hasOwnProperty.call(loaded, "__proto__")).toBe(true);
    expect(loaded["__proto__"]).toBe("ordinary data");
  });

  it("rejects a stale tab save without overwriting the newer draft", async () => {
    const firstTab = await createAccountStorage("user-a");
    const staleTab = await createAccountStorage("user-a");
    firstTab.saveStored("workspaceDraftFiles", [{ content: "newer edit", path: "printer.cfg" }]);
    await firstTab.status.flush();

    staleTab.saveStored("workspaceDraftFiles", [{ content: "stale edit", path: "printer.cfg" }]);
    await expect(staleTab.status.flush()).rejects.toThrow(/newer workspace/i);
    expect(staleTab.loadStored<Array<{ content: string }>>("workspaceDraftFiles", [])[0].content).toBe("stale edit");

    const reopened = await createAccountStorage("user-a");
    expect(reopened.loadStored<Array<{ content: string }>>("workspaceDraftFiles", [])[0].content).toBe("newer edit");
    const otherAccount = await createAccountStorage("user-b");
    otherAccount.saveStored("workspaceDraftFiles", [{ content: "other account", path: "printer.cfg" }]);
    await otherAccount.status.flush();
    expect(otherAccount.loadStored<Array<{ content: string }>>("workspaceDraftFiles", [])[0].content).toBe("other account");
  });

  it("adopts an identical newer tab value without creating a false conflict", async () => {
    const firstTab = await createAccountStorage("user-a");
    const secondTab = await createAccountStorage("user-a");
    firstTab.saveStored("workspaceContent", "same draft");
    await firstTab.status.flush();
    secondTab.saveStored("workspaceContent", "same draft");
    await secondTab.status.flush();
    expect(secondTab.status.getSnapshot()).toMatchObject({ error: null, retryable: false });
  });

  it("does not treat undefined metadata as equal to null metadata", async () => {
    const firstTab = await createAccountStorage("user-a");
    const staleTab = await createAccountStorage("user-a");
    firstTab.saveStored("optionalValue", undefined);
    await firstTab.status.flush();
    staleTab.saveStored("optionalValue", null);
    await expect(staleTab.status.flush()).rejects.toThrow(/newer workspace/i);
  });

  it("detects a legacy import that appears after a tab hydrated an empty key", async () => {
    const staleTab = await createAccountStorage("user-a");
    localStorage.setItem(accountStorageKey("user-a", "workspaceContent"), JSON.stringify("legacy draft"));
    const importTab = await createAccountStorage("user-a");
    expect(importTab.loadStored("workspaceContent", "missing")).toBe("legacy draft");
    staleTab.saveStored("workspaceContent", "competing new draft");
    await expect(staleTab.status.flush()).rejects.toThrow(/newer workspace/i);
    expect(importTab.loadStored("workspaceContent", "missing")).toBe("legacy draft");
  });

  it("aborts every key in a batch when a write fails midway", async () => {
    const storage = await createAccountStorage("user-a");
    const originalPut = IDBObjectStore.prototype.put;
    let metadataWrites = 0;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "accountMetadata") {
        metadataWrites += 1;
        if (metadataWrites === 2) throw new DOMException("storage full", "QuotaExceededError");
      }
      return originalPut.apply(this, args);
    });
    storage.saveStored("printer", { name: "local printer" });
    storage.saveStored("workspaceContent", "local draft");
    await expect(storage.status.flush()).rejects.toThrow(/storage is full/i);
    put.mockRestore();

    const reopened = await createAccountStorage("user-a");
    expect(reopened.hasStored("printer")).toBe(false);
    expect(reopened.hasStored("workspaceContent")).toBe(false);
    expect(storage.loadStored("workspaceContent", "missing")).toBe("local draft");
  });

  it("archives reintroduced legacy values when a newer durable value already exists", async () => {
    const storageKey = accountStorageKey("user-a", "workspaceContent");
    localStorage.setItem(storageKey, JSON.stringify("durable active value"));
    const first = await createAccountStorage("user-a");
    await first.status.flush();

    localStorage.setItem(storageKey, JSON.stringify("conflicting old-tab value"));
    const reopened = await createAccountStorage("user-a");
    expect(reopened.loadStored("workspaceContent", "missing")).toBe("durable active value");
    expect(localStorage.getItem(storageKey)).toBeNull();
    const quarantine = await allRecords<{ key: string; scope: string; value: unknown }>("accountMetadata");
    expect(quarantine.some((record) => record.scope === "legacy-quarantine"
      && record.key.startsWith("legacy-conflict:user:user-a:workspaceContent:")
      && record.value === '"conflicting old-tab value"')).toBe(true);
  });

  it("keeps edits in memory and exposes quota failures for retry", async () => {
    const storage = await createAccountStorage("user-a");
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("storage full", "QuotaExceededError");
    });
    storage.saveStored("workspaceContent", "unsaved but still editable");
    await expect(storage.status.flush()).rejects.toThrow(/storage is full/i);
    expect(storage.loadStored("workspaceContent", "missing")).toBe("unsaved but still editable");
    expect(storage.status.getSnapshot()).toMatchObject({ pending: 0, retryable: true });
    put.mockRestore();
    await storage.status.retry();
    expect(storage.status.getSnapshot()).toMatchObject({ error: null, pending: 0, retryable: false });
  });
});
