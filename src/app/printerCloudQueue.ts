/**
 * Per-printer serialized cloud write queue with account-boundary invalidation.
 *
 * Operations enqueued for the same printer run strictly one after another;
 * operations for different printers proceed independently. Every operation
 * captures the queue generation and auth user at enqueue time and is dropped
 * (resolves `false`, never runs) if either changed by the time its turn
 * arrives: a queued write must never cross an account/session boundary.
 *
 * The queue also tracks printers deleted from the cloud so writes queued
 * behind a delete can be skipped; that set shares the queue's lifetime and is
 * cleared on every invalidation.
 */
export interface PrinterCloudQueue {
  /** Auth user the queue currently accepts operations for. */
  readonly authUserId: string | null;
  /** Current invalidation generation; bumped by {@link invalidate}. */
  readonly generation: number;
  /**
   * Chain `operation` behind the pending operations for `printerId`. The
   * returned promise resolves with the operation result, or `false` when the
   * operation was dropped by an invalidation or a missing auth user. A
   * rejection from `operation` propagates to the returned promise but never
   * blocks later operations for the same printer.
   */
  enqueue(printerId: string, operation: () => Promise<boolean>): Promise<boolean>;
  /**
   * Drop every queued-but-not-started operation. The request already in
   * flight cannot be recalled, but everything waiting behind it observes the
   * generation change and resolves `false`.
   */
  invalidate(): void;
  isDeleted(printerId: string): boolean;
  markDeleted(printerId: string): void;
  /**
   * Adopt a new auth user. A change (including to `null`) invalidates the
   * queue immediately so no queued write can resume under a newly issued
   * session; an unchanged id is a no-op.
   */
  setAuthUserId(authUserId: string | null): void;
}

export function createPrinterCloudQueue(): PrinterCloudQueue {
  let generation = 0;
  let authUserId: string | null = null;
  const tails = new Map<string, Promise<void>>();
  const deletedPrinterIds = new Set<string>();

  function invalidate() {
    generation += 1;
    tails.clear();
    deletedPrinterIds.clear();
  }

  return {
    get authUserId() {
      return authUserId;
    },
    get generation() {
      return generation;
    },
    enqueue(printerId, operation) {
      const enqueueGeneration = generation;
      const enqueueAuthUserId = authUserId;
      const previous = tails.get(printerId) ?? Promise.resolve();
      const result = previous.then(() => {
        if (
          !enqueueAuthUserId
          || enqueueGeneration !== generation
          || enqueueAuthUserId !== authUserId
        ) {
          return false;
        }
        return operation();
      });
      const tail = result.then(() => undefined, () => undefined);
      tails.set(printerId, tail);
      void tail.then(() => {
        if (tails.get(printerId) === tail) {
          tails.delete(printerId);
        }
      });
      return result;
    },
    invalidate,
    isDeleted(printerId) {
      return deletedPrinterIds.has(printerId);
    },
    markDeleted(printerId) {
      deletedPrinterIds.add(printerId);
    },
    setAuthUserId(nextAuthUserId) {
      if (authUserId === nextAuthUserId) {
        return;
      }
      // A queued write must never cross an account/session boundary. Detach
      // the new session from old tails immediately, before a promise
      // microtask can resume with a newly issued browser cookie.
      authUserId = nextAuthUserId;
      invalidate();
    },
  };
}
