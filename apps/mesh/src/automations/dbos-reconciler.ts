/**
 * Boot-time reconciler.
 *
 * `automation_triggers` (mesh) and DBOS `schedules` are two stores. Crash
 * recovery, deploys with the flag flipping, and any window where a CRUD
 * succeeded against one store but not the other can leave them out of sync.
 *
 * This reconciler runs once after `DBOS.launch()`:
 *   - schedules in DBOS without a matching active cron trigger → delete
 *   - active cron triggers without a matching DBOS schedule → create
 *
 * We do not touch existing schedules whose trigger is also present:
 * `applySchedules`'s delete+recreate would wipe `lastFiredAt`, causing every
 * surviving cron trigger to re-fire on every restart. Cron expressions can't
 * change for an existing trigger row (there's no update path), so existence
 * is the only thing we need to check.
 */

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
}

export async function reconcileAutomationSchedules(
  storage: AutomationsStorage,
): Promise<ReconcileResult> {
  const activeCronTriggers = await storage.findAllActiveCronTriggers();
  const existing = await DBOS.listSchedules({
    scheduleNamePrefix: AUTOMATION_SCHEDULE_PREFIX,
  });

  const existingNames = new Set(existing.map((s) => s.scheduleName));
  const wantedNames = new Set(
    activeCronTriggers.map((t) => scheduleNameForTrigger(t.id)),
  );

  let created = 0;
  let deleted = 0;
  let kept = 0;

  for (const trigger of activeCronTriggers) {
    const name = scheduleNameForTrigger(trigger.id);
    if (existingNames.has(name)) {
      kept++;
      continue;
    }
    try {
      await syncTriggerCreated(trigger, trigger.automation);
      created++;
    } catch (err) {
      console.error(
        `[automation-reconciler] createSchedule(${name}) failed:`,
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

  console.log(
    `[automation-reconciler] reconciled schedules — created=${created} deleted=${deleted} kept=${kept}`,
  );

  return { created, deleted, kept };
}
