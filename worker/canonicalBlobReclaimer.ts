import { DurableObject } from "cloudflare:workers";
import { unwrapDatabaseError } from "./databaseErrors";
import { applyCanonicalBlobReclaim } from "./routes/storageMaintenance";
import type { Env } from "./types";

/**
 * One instance per canonical hash serializes the R2 HEAD/delete/finalize
 * sequence. The in-memory RPC queue intentionally spans external I/O:
 * Durable Objects remain active while calls and I/O are in flight, and this
 * avoids blockConcurrencyWhile's 30-second reset limit. Overlapping
 * deleters cannot be allowed to release the D1 fence and then delete a
 * replacement object from a stale pre-delete observation.
 */
export class CanonicalBlobReclaimer extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  private async notifyQueuedTestHook(hash: string) {
    if (this.env.LOCAL_AUTH_BYPASS !== "1" || !this.env.STORAGE_RECLAIM_TEST_HOOK) return;
    try {
      await this.env.STORAGE_RECLAIM_TEST_HOOK.fetch(
        `https://storage-reclaim.test/queued/${hash}`,
        { method: "POST" },
      );
    } catch (caught) {
      const error = unwrapDatabaseError(caught);
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        hash,
        level: "error",
        type: "canonical_blob_reclaimer_test_hook_failure",
      }));
    }
  }

  async reclaim(hash: string, resumeToken: string | null) {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await this.notifyQueuedTestHook(hash);
    await previous;
    try {
      return await applyCanonicalBlobReclaim(this.env, hash, resumeToken ?? undefined);
    } catch (caught) {
      const error = unwrapDatabaseError(caught);
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        error: message,
        hash,
        level: "error",
        type: "canonical_blob_reclaimer_failure",
      }));
      return { error: message, status: "reclamation_failed" as const };
    } finally {
      release();
    }
  }
}
