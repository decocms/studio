import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";

import { getLogsDir, getMetricsDir, getTracesDir } from "./schema";
import { cleanupOldMonitoringFiles } from "./ndjson-retention";

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

let registered = false;

// Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerMonitoringRetentionWorkflow(): void {
  if (registered) return;
  registered = true;
  const wf = DBOS.registerWorkflow(monitoringRetentionWorkflowFn, {
    name: "monitoringRetentionWorkflow",
  });
  DBOS.registerScheduled(wf, {
    name: "monitoringRetentionWorkflow",
    crontab: MONITORING_RETENTION_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
