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
}

const AUTOMATION_WORKFLOW_NAMES = [
  "cronEntryWorkflow",
  "automationOrgGateWorkflow",
  "automationGateWorkflow",
  "fireAutomationWorkflow",
] as const;

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

  type Tally = Pick<ReconcileResult, "created" | "kept" | "paused" | "resumed">;
  const zero: Tally = { created: 0, kept: 0, paused: 0, resumed: 0 };

  const triggerOutcomes = await Promise.all(
    triggers.map(async (trigger): Promise<Tally> => {
      const name = scheduleNameForTrigger(trigger.id);
      const tally: Tally = { ...zero };

      if (existingNames.has(name)) {
        tally.kept = 1;
      } else {
        try {
          await syncTriggerCreated(trigger, trigger.automation);
          tally.created = 1;
        } catch (err) {
          console.error(
            `[automation-reconciler] createSchedule(${name}) failed:`,
            err instanceof Error ? err.message : err,
          );
          return tally;
        }
      }

      // Self-heal a missed pause/resume after a crash between CRUD and DBOS.
      try {
        if (trigger.automation.active) {
          await DBOS.resumeSchedule(name);
          tally.resumed = 1;
        } else {
          await DBOS.pauseSchedule(name);
          tally.paused = 1;
        }
      } catch (err) {
        console.warn(
          `[automation-reconciler] ${trigger.automation.active ? "resume" : "pause"}Schedule(${name}) failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      return tally;
    }),
  );

  const deleteOutcomes = await Promise.all(
    existing
      .filter((s) => !wantedNames.has(s.scheduleName))
      .map(async (sched) => {
        try {
          await DBOS.deleteSchedule(sched.scheduleName);
          return 1;
        } catch (err) {
          console.error(
            `[automation-reconciler] deleteSchedule(${sched.scheduleName}) failed:`,
            err instanceof Error ? err.message : err,
          );
          return 0;
        }
      }),
  );

  const { created, kept, paused, resumed } = triggerOutcomes.reduce<Tally>(
    (acc, t) => ({
      created: acc.created + t.created,
      kept: acc.kept + t.kept,
      paused: acc.paused + t.paused,
      resumed: acc.resumed + t.resumed,
    }),
    zero,
  );
  const deleted = deleteOutcomes.reduce<number>((a, b) => a + b, 0);
  const orphansCancelled = await cancelOrphanedEnqueued();

  console.log(
    `[automation-reconciler] reconciled — created=${created} deleted=${deleted} kept=${kept} resumed=${resumed} paused=${paused} orphansCancelled=${orphansCancelled}`,
  );

  return { created, deleted, kept, paused, resumed, orphansCancelled };
}
