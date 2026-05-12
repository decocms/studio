/**
 * DBOS scheduled workflow for NDJSON monitoring file retention.
 *
 * Registered as a static schedule via `DBOS.registerScheduled` at module
 * load — state lives in `event_dispatch_kv`, so re-registration on restart
 * is implicitly idempotent (no `workflow_schedules` row to collide with).
 * Multi-replica coordination uses `upsertEventDispatchState` so only one
 * replica fires per tick; the step itself is idempotent — replays just
 * compute a fresh cutoff and delete the next eligible day directories.
 */
import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";

import { getLogsDir, getMetricsDir, getTracesDir } from "./schema";
import { cleanupOldMonitoringFiles } from "./ndjson-retention";

/** 04:23 UTC daily — off-peak with a minute offset to avoid colliding with hourly tasks. */
const MONITORING_RETENTION_CRONTAB = "23 4 * * *";

export interface MonitoringRetentionResult {
  deleted: number;
  dirs: number;
}

async function monitoringRetentionStep(): Promise<MonitoringRetentionResult> {
  const dirs = [getLogsDir(), getTracesDir(), getMetricsDir()];
  let deleted = 0;

  for (const dir of dirs) {
    try {
      deleted += await cleanupOldMonitoringFiles(dir);
    } catch (err) {
      console.error("[monitoring-retention] cleanup failed:", err);
    }
  }

  console.log(
    `[monitoring-retention] deleted ${deleted} day-dir(s) across ${dirs.length} signal dir(s)`,
  );
  return { deleted, dirs: dirs.length };
}

async function monitoringRetentionWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  await DBOS.runStep(() => monitoringRetentionStep(), {
    name: "monitoringRetention",
  });
}

const monitoringRetentionWorkflow = DBOS.registerWorkflow(
  monitoringRetentionWorkflowFn,
  { name: "monitoringRetentionWorkflow" },
);

DBOS.registerScheduled(monitoringRetentionWorkflow, {
  name: "monitoringRetentionWorkflow",
  crontab: MONITORING_RETENTION_CRONTAB,
  mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
});
