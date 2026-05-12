/**
 * DBOS scheduled workflow for NDJSON monitoring file retention.
 *
 * Replaces the legacy `setInterval` in `api/app.ts` that swept old
 * monitoring directories every 24 hours. Now a DBOS schedule ensures only
 * one replica runs the sweep per tick (row-locked `last_fired_at`) and the
 * step itself is idempotent — replays just compute a fresh cutoff and
 * delete the next eligible day directories.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";

import { getLogsDir, getMetricsDir, getTracesDir } from "./schema";
import { cleanupOldMonitoringFiles } from "./ndjson-retention";

export const MONITORING_RETENTION_SCHEDULE_NAME = "monitoring-ndjson-retention";
/** 04:23 UTC daily — off-peak with a minute offset to avoid colliding with hourly tasks. */
export const MONITORING_RETENTION_SCHEDULE = "23 4 * * *";

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
  _ctx: Record<string, unknown>,
): Promise<void> {
  // `DBOS.createSchedule` requires `Promise<void>`. The step's return value
  // is recorded in `operation_outputs` for observability.
  await DBOS.runStep(() => monitoringRetentionStep(), {
    name: "monitoringRetention",
  });
}

export const monitoringRetentionWorkflow = DBOS.registerWorkflow(
  monitoringRetentionWorkflowFn,
  { name: "monitoringRetentionWorkflow" },
);
