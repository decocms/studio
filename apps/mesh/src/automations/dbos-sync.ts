/**
 * Thin sync layer between mesh's `automation_triggers` table and DBOS schedules.
 *
 * Mesh treats `automation_triggers` as the source of truth (it carries
 * user-facing config: cron expression, params, etc.). DBOS owns the actual
 * scheduling, recovery, and concurrency.
 *
 * On every trigger CRUD the caller mirrors the change to DBOS. Drift is
 * bounded by reboot cadence; `dbos-reconciler.ts` re-syncs at boot.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Automation, AutomationTrigger } from "@/storage/types";
import {
  cronEntryWorkflow,
  ensureOrgQueue,
  orgGateWorkflow,
  orgQueueName,
  type FireAutomationContext,
  type FireAutomationOutcome,
} from "./dbos-workflow";

/** Build the DBOS schedule name from a mesh trigger row. */
export function scheduleNameForTrigger(triggerId: string): string {
  return `auto-trigger-${triggerId}`;
}

/** Common prefix used by the reconciler to enumerate our schedules. */
export const AUTOMATION_SCHEDULE_PREFIX = "auto-trigger-";

/**
 * Mirror a newly-created cron trigger to DBOS as a schedule. Non-cron triggers
 * are no-ops (event triggers fire via EventTriggerEngine.startWorkflow directly,
 * not via the scheduler).
 */
export async function syncTriggerCreated(
  trigger: AutomationTrigger,
  automation: Automation,
): Promise<void> {
  if (trigger.type !== "cron" || !trigger.cron_expression) return;

  await DBOS.createSchedule({
    scheduleName: scheduleNameForTrigger(trigger.id),
    workflowFn: cronEntryWorkflow,
    schedule: trigger.cron_expression,
    context: {
      automationId: automation.id,
      organizationId: automation.organization_id,
      triggerId: trigger.id,
    } satisfies FireAutomationContext,
  });
}

/**
 * Mirror a trigger deletion to DBOS. Safe to call for any trigger type and
 * even when the schedule doesn't exist — caught and logged so trigger removal
 * never blocks on DBOS state.
 */
export async function syncTriggerDeleted(triggerId: string): Promise<void> {
  try {
    await DBOS.deleteSchedule(scheduleNameForTrigger(triggerId));
  } catch (err) {
    console.warn(
      `[dbos-sync] deleteSchedule(${triggerId}) failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Pause/resume all schedules tied to an automation. Called when the
 * automation's active flag toggles. Best-effort per schedule.
 */
export async function syncAutomationActiveChanged(
  triggers: AutomationTrigger[],
  active: boolean,
): Promise<void> {
  const cronTriggers = triggers.filter((t) => t.type === "cron");
  await Promise.allSettled(
    cronTriggers.map(async (t) => {
      try {
        if (active) {
          await DBOS.resumeSchedule(scheduleNameForTrigger(t.id));
        } else {
          await DBOS.pauseSchedule(scheduleNameForTrigger(t.id));
        }
      } catch (err) {
        console.warn(
          `[dbos-sync] ${active ? "resume" : "pause"}Schedule(${t.id}) failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}

/**
 * Cascade-delete all schedules for an automation. Used by AUTOMATION_DELETE,
 * which removes the automation and all its triggers in a single DB cascade —
 * DBOS doesn't know about that cascade, so we delete its schedules explicitly.
 */
export async function syncAutomationDeleted(
  triggers: AutomationTrigger[],
): Promise<void> {
  await Promise.allSettled(
    triggers
      .filter((t) => t.type === "cron")
      .map((t) => syncTriggerDeleted(t.id)),
  );
}

/**
 * Enqueue an immediate fire through the org gate queue. Used by:
 *   - AUTOMATION_RUN (manual "run now") — bypasses any trigger
 *   - EventTriggerEngine — fires on event-matched triggers
 *
 * Routes through `orgGateWorkflow` so per-org, per-automation, and global
 * concurrency caps all apply (same chain the cron scheduler uses). Returns
 * the workflow's eventual result. Callers that need fire-and-forget
 * semantics should `.catch()` the returned promise.
 *
 * `idempotencyKey` (when supplied) is used as the top-level DBOS workflow ID,
 * giving exactly-once semantics across at-least-once event delivery. Callers
 * with no stable key (e.g. AUTOMATION_RUN) should omit it; DBOS will
 * generate a UUID and each call fires independently.
 */
export async function fireAutomationNow(
  ctx: FireAutomationContext,
  opts?: { idempotencyKey?: string },
): Promise<FireAutomationOutcome> {
  await ensureOrgQueue(ctx.organizationId);
  const workflowID = opts?.idempotencyKey
    ? `auto:${ctx.automationId}:${opts.idempotencyKey}`
    : undefined;
  const handle = await DBOS.startWorkflow(orgGateWorkflow, {
    workflowID,
    queueName: orgQueueName(ctx.organizationId),
  })(ctx);
  return await handle.getResult();
}
