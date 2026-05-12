import { DBOS } from "@dbos-inc/dbos-sdk";
import type { AutomationsStorage } from "@/storage/automations";
import {
  AUTOMATION_SCHEDULE_PREFIX,
  scheduleNameForTrigger,
  syncTriggerCreated,
} from "./dbos-sync";

export interface ReconcileResult {
  created: number;
  deleted: number;
  kept: number;
  paused: number;
  resumed: number;
  orphansCancelled: number;
  stuckThreadsFailed: number;
}

const AUTOMATION_WORKFLOW_NAMES = [
  "cronEntryWorkflow",
  "automationOrgGateWorkflow",
  "automationGateWorkflow",
  "fireAutomationWorkflow",
] as const;

// Bigger than the 5-min fire timeout to leave headroom for slow shutdowns.
const STUCK_THREAD_AGE_MS = 15 * 60 * 1000;

// DBOS only dequeues rows matching the current `application_version`; older
// ENQUEUED rows would otherwise accumulate forever.
async function cancelOrphanedEnqueued(): Promise<number> {
  const orphans = await DBOS.listWorkflows({
    status: ["ENQUEUED"],
    workflowName: [...AUTOMATION_WORKFLOW_NAMES],
    loadInput: false,
    loadOutput: false,
  });
  const stale = orphans
    .filter((w) => w.applicationVersion !== DBOS.applicationVersion)
    .map((w) => w.workflowID);
  if (stale.length) await DBOS.cancelWorkflows(stale);
  return stale.length;
}

export async function reconcileAutomationSchedules(
  storage: AutomationsStorage,
): Promise<ReconcileResult> {
  const triggers = await storage.findAllCronTriggers();
  const existing = await DBOS.listSchedules({
    scheduleNamePrefix: AUTOMATION_SCHEDULE_PREFIX,
  });

  const existingNames = new Set(existing.map((s) => s.scheduleName));
  const wantedNames = new Set(
    triggers.map((t) => scheduleNameForTrigger(t.id)),
  );

  let created = 0;
  let deleted = 0;
  let kept = 0;
  let paused = 0;
  let resumed = 0;

  for (const trigger of triggers) {
    const name = scheduleNameForTrigger(trigger.id);
    if (existingNames.has(name)) {
      kept++;
    } else {
      try {
        await syncTriggerCreated(trigger, trigger.automation);
        created++;
      } catch (err) {
        console.error(
          `[automation-reconciler] createSchedule(${name}) failed:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
    }

    // Self-heal a missed pause/resume after a crash between CRUD and DBOS.
    try {
      if (trigger.automation.active) {
        await DBOS.resumeSchedule(name);
        resumed++;
      } else {
        await DBOS.pauseSchedule(name);
        paused++;
      }
    } catch (err) {
      console.warn(
        `[automation-reconciler] ${trigger.automation.active ? "resume" : "pause"}Schedule(${name}) failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  for (const sched of existing) {
    if (wantedNames.has(sched.scheduleName)) continue;
    try {
      await DBOS.deleteSchedule(sched.scheduleName);
      deleted++;
    } catch (err) {
      console.error(
        `[automation-reconciler] deleteSchedule(${sched.scheduleName}) failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const orphansCancelled = await cancelOrphanedEnqueued();

  const cutoff = new Date(Date.now() - STUCK_THREAD_AGE_MS).toISOString();
  let stuckThreadsFailed = 0;
  try {
    stuckThreadsFailed = await storage.failStuckRunThreads(cutoff);
  } catch (err) {
    console.error(
      "[automation-reconciler] failStuckRunThreads failed:",
      err instanceof Error ? err.message : err,
    );
  }

  console.log(
    `[automation-reconciler] reconciled — created=${created} deleted=${deleted} kept=${kept} resumed=${resumed} paused=${paused} orphansCancelled=${orphansCancelled} stuckThreadsFailed=${stuckThreadsFailed}`,
  );

  return {
    created,
    deleted,
    kept,
    paused,
    resumed,
    orphansCancelled,
    stuckThreadsFailed,
  };
}
