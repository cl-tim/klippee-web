import { describe, expect, it, vi } from "vitest";
import { createPrinterCloudQueue } from "./printerCloudQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("createPrinterCloudQueue", () => {
  it("runs operations for the same printer strictly one after another", async () => {
    const queue = createPrinterCloudQueue();
    queue.setAuthUserId("user-1");
    const first = deferred<boolean>();
    const events: string[] = [];

    const firstResult = queue.enqueue("printer-a", () => {
      events.push("first:start");
      return first.promise;
    });
    const secondResult = queue.enqueue("printer-a", () => {
      events.push("second:start");
      return Promise.resolve(true);
    });

    await flushMicrotasks();
    expect(events).toEqual(["first:start"]);

    first.resolve(true);
    await expect(firstResult).resolves.toBe(true);
    await expect(secondResult).resolves.toBe(true);
    expect(events).toEqual(["first:start", "second:start"]);
  });

  it("does not serialize operations across different printers", async () => {
    const queue = createPrinterCloudQueue();
    queue.setAuthUserId("user-1");
    const blocker = deferred<boolean>();
    const events: string[] = [];

    void queue.enqueue("printer-a", () => {
      events.push("a:start");
      return blocker.promise;
    });
    const otherResult = queue.enqueue("printer-b", () => {
      events.push("b:start");
      return Promise.resolve(true);
    });

    await expect(otherResult).resolves.toBe(true);
    expect(events).toEqual(["a:start", "b:start"]);
    blocker.resolve(true);
  });

  it("drops operations enqueued without an auth user", async () => {
    const queue = createPrinterCloudQueue();
    const operation = vi.fn(() => Promise.resolve(true));

    await expect(queue.enqueue("printer-a", operation)).resolves.toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });

  it("drops queued operations when the queue is invalidated before they run", async () => {
    const queue = createPrinterCloudQueue();
    queue.setAuthUserId("user-1");
    const inFlight = deferred<boolean>();
    const queuedOperation = vi.fn(() => Promise.resolve(true));

    const inFlightResult = queue.enqueue("printer-a", () => inFlight.promise);
    // Let the first operation actually start before invalidating.
    await flushMicrotasks();
    const queuedResult = queue.enqueue("printer-a", queuedOperation);

    queue.invalidate();
    inFlight.resolve(true);

    // The in-flight request cannot be recalled, but the queued write behind
    // it observes the generation change and is cancelled.
    await expect(inFlightResult).resolves.toBe(true);
    await expect(queuedResult).resolves.toBe(false);
    expect(queuedOperation).not.toHaveBeenCalled();
  });

  it("drops queued operations when the auth user changes before they run", async () => {
    const queue = createPrinterCloudQueue();
    queue.setAuthUserId("user-1");
    const inFlight = deferred<boolean>();
    const queuedOperation = vi.fn(() => Promise.resolve(true));

    void queue.enqueue("printer-a", () => inFlight.promise);
    // Let the first operation actually start before switching accounts.
    await flushMicrotasks();
    const queuedResult = queue.enqueue("printer-a", queuedOperation);

    queue.setAuthUserId("user-2");
    inFlight.resolve(true);

    await expect(queuedResult).resolves.toBe(false);
    expect(queuedOperation).not.toHaveBeenCalled();

    // Operations enqueued under the new session still run.
    const nextOperation = vi.fn(() => Promise.resolve(true));
    await expect(queue.enqueue("printer-a", nextOperation)).resolves.toBe(true);
    expect(nextOperation).toHaveBeenCalledTimes(1);
  });

  it("keeps setAuthUserId a no-op when the auth user is unchanged", async () => {
    const queue = createPrinterCloudQueue();
    queue.setAuthUserId("user-1");
    const generation = queue.generation;
    const blocker = deferred<boolean>();
    const queuedOperation = vi.fn(() => Promise.resolve(true));

    void queue.enqueue("printer-a", () => blocker.promise);
    const queuedResult = queue.enqueue("printer-a", queuedOperation);

    queue.setAuthUserId("user-1");
    expect(queue.generation).toBe(generation);

    blocker.resolve(true);
    await expect(queuedResult).resolves.toBe(true);
    expect(queuedOperation).toHaveBeenCalledTimes(1);
  });

  it("propagates operation errors to the caller without blocking the queue", async () => {
    const queue = createPrinterCloudQueue();
    queue.setAuthUserId("user-1");
    const failure = new Error("cloud save exploded");

    const failedResult = queue.enqueue("printer-a", () => Promise.reject(failure));
    await expect(failedResult).rejects.toBe(failure);

    // A later operation for the same printer still runs after the failure.
    const nextOperation = vi.fn(() => Promise.resolve(true));
    await expect(queue.enqueue("printer-a", nextOperation)).resolves.toBe(true);
    expect(nextOperation).toHaveBeenCalledTimes(1);
  });

  it("clears deleted-printer tracking on invalidation", () => {
    const queue = createPrinterCloudQueue();
    queue.setAuthUserId("user-1");
    queue.markDeleted("printer-a");
    expect(queue.isDeleted("printer-a")).toBe(true);

    queue.setAuthUserId("user-2");
    expect(queue.isDeleted("printer-a")).toBe(false);

    queue.markDeleted("printer-a");
    queue.invalidate();
    expect(queue.isDeleted("printer-a")).toBe(false);
  });
});
