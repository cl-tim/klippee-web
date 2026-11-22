import {
  expiredAuthCleanupBatchSize,
} from "./storageLimits";
import type { Env } from "./types";
import { removeExpiredCanonicalBlobWriteLeases } from "./blobBudget";
import { removeExpiredRenderedZipArtifacts } from "./packageRendering";
import { removeExpiredOAuthStates, removeExpiredSessions } from "./routes/auth";
import { removeExpiredDiagnosticUploads } from "./routes/diagnosticUploads";
import { removeExpiredLogImprovementSubmissions } from "./routes/logImprovementSubmissions";
import { unwrapDatabaseError } from "./databaseErrors";

const maximumBatchesPerTask = 10;

type MaintenanceTask = {
  batchSize: number;
  name: string;
  removeBatch: (env: Env) => Promise<number>;
};

const maintenanceTasks: readonly MaintenanceTask[] = [
  {
    batchSize: expiredAuthCleanupBatchSize,
    name: "expired_sessions",
    removeBatch: removeExpiredSessions,
  },
  {
    batchSize: expiredAuthCleanupBatchSize,
    name: "expired_oauth_states",
    removeBatch: removeExpiredOAuthStates,
  },
  {
    batchSize: 50,
    name: "expired_diagnostic_uploads",
    removeBatch: removeExpiredDiagnosticUploads,
  },
  {
    batchSize: 50,
    name: "expired_log_improvement_submissions",
    removeBatch: removeExpiredLogImprovementSubmissions,
  },
  {
    batchSize: 500,
    name: "expired_rendered_zip_artifacts",
    removeBatch: removeExpiredRenderedZipArtifacts,
  },
  {
    batchSize: 500,
    name: "expired_canonical_blob_write_leases",
    removeBatch: removeExpiredCanonicalBlobWriteLeases,
  },
];

function errorDetails(error: unknown) {
  error = unwrapDatabaseError(error);
  return {
    errorName: (error instanceof Error ? error.name : "Error").slice(0, 128),
    errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 2_048),
  };
}

export async function runScheduledMaintenance(
  controller: ScheduledController,
  env: Env,
) {
  const runStartedAt = Date.now();
  const runId = crypto.randomUUID();
  const batchLimitReachedTasks: string[] = [];
  const failedTasks: string[] = [];
  let totalRemoved = 0;

  console.log({
    level: "info",
    type: "scheduled_maintenance_run",
    status: "started",
    runId,
    cron: controller.cron,
    scheduledTime: controller.scheduledTime,
    taskCount: maintenanceTasks.length,
  });

  for (const task of maintenanceTasks) {
    const taskStartedAt = Date.now();
    let batches = 0;
    let lastBatchRemoved = 0;
    let removed = 0;

    console.log({
      level: "info",
      type: "scheduled_maintenance_task",
      status: "started",
      runId,
      task: task.name,
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });

    try {
      for (let batch = 0; batch < maximumBatchesPerTask; batch += 1) {
        lastBatchRemoved = await task.removeBatch(env);
        if (!Number.isSafeInteger(lastBatchRemoved) || lastBatchRemoved < 0) {
          throw new Error(`Maintenance task returned an invalid removal count: ${lastBatchRemoved}`);
        }
        batches += 1;
        removed += lastBatchRemoved;
        if (lastBatchRemoved < task.batchSize) break;
      }

      totalRemoved += removed;
      const batchLimitReached = batches === maximumBatchesPerTask
        && lastBatchRemoved >= task.batchSize;
      if (batchLimitReached) batchLimitReachedTasks.push(task.name);
      const taskSummary = {
        level: batchLimitReached ? "warn" : "info",
        type: "scheduled_maintenance_task",
        status: "succeeded",
        runId,
        task: task.name,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        batchesCompleted: batches,
        itemsRemoved: removed,
        batchLimitReached,
        durationMs: Date.now() - taskStartedAt,
      };
      if (batchLimitReached) {
        console.warn(taskSummary);
      } else {
        console.log(taskSummary);
      }
    } catch (error) {
      failedTasks.push(task.name);
      totalRemoved += removed;
      console.error({
        level: "error",
        type: "scheduled_maintenance_task",
        status: "failed",
        runId,
        task: task.name,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        batchesCompleted: batches,
        itemsRemoved: removed,
        batchLimitReached: false,
        durationMs: Date.now() - taskStartedAt,
        ...errorDetails(error),
      });
    }
  }

  const runSummary = {
    level: failedTasks.length > 0 ? "error" : "info",
    type: "scheduled_maintenance_run",
    status: failedTasks.length > 0 ? "failed" : "succeeded",
    runId,
    cron: controller.cron,
    scheduledTime: controller.scheduledTime,
    taskCount: maintenanceTasks.length,
    failedTasks,
    batchLimitReachedTasks,
    itemsRemoved: totalRemoved,
    durationMs: Date.now() - runStartedAt,
  };
  if (failedTasks.length > 0) {
    console.error(runSummary);
    throw new Error(`Scheduled maintenance failed: ${failedTasks.join(", ")}`);
  }
  console.log(runSummary);
}
