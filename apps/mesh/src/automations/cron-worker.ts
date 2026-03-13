/**
 * Automation Cron Worker
 *
 * Periodically checks all active cron triggers and fires automations that are
 * due. Instead of storing `next_run_at` (fragile — a failed update loses the
 * trigger), we store `last_run_at` and compute due-ness from the cron
 * expression. If `last_run_at` update fails, worst case the trigger fires
 * again (much safer than losing it forever).
 *
 * Follows the same coalescing-loop pattern as EventBusWorker:
 *   - `processNow()` is called by an external timer / polling strategy
 *   - Concurrent calls are coalesced so at most one `processDueTriggers`
 *     runs at a time, with a follow-up if notifications arrived mid-flight.
 */

import type { StreamCoreDeps } from "@/api/routes/decopilot/stream-core";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation, AutomationTrigger } from "@/storage/types";
import { Cron } from "croner";
import {
  fireAutomation,
  type FireAutomationConfig,
  type MeshContextFactory,
  type StreamCoreFn,
} from "./fire";
import type { Semaphore } from "./semaphore";

export class AutomationCronWorker {
  private running = false;
  private processing = false;
  private pendingNotify = false;

  constructor(
    private storage: AutomationsStorage,
    private streamCoreFn: StreamCoreFn,
    private meshContextFactory: MeshContextFactory,
    private config: FireAutomationConfig,
    private globalSemaphore: Semaphore,
    private deps: Pick<StreamCoreDeps, "runRegistry" | "cancelBroadcast">,
    private now: () => Date = () => new Date(),
  ) {}

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /**
   * Trigger a processing cycle.
   * Called by the polling timer; concurrent calls are coalesced.
   */
  async processNow(): Promise<void> {
    if (!this.running) return;
    if (this.processing) {
      this.pendingNotify = true;
      return;
    }

    this.processing = true;
    try {
      do {
        this.pendingNotify = false;
        await this.processDueTriggers();
      } while (this.pendingNotify);
    } finally {
      this.processing = false;
    }
  }

  // --------------------------------------------------------------------------
  // Static helpers
  // --------------------------------------------------------------------------

  /**
   * Check if a cron trigger is due based on its expression and last_run_at.
   *
   * A trigger is due when the next scheduled occurrence after `last_run_at`
   * is at or before `now`. If the trigger has never run, it's always due.
   */
  static isDue(
    cronExpression: string,
    lastRunAt: string | null,
    now: Date,
  ): boolean {
    try {
      const cron = new Cron(cronExpression, { timezone: "UTC" });

      // Never run → always due
      if (!lastRunAt) return true;

      // Compute the next scheduled occurrence after last_run_at
      const nextScheduled = cron.nextRun(new Date(lastRunAt));
      return nextScheduled != null && nextScheduled.getTime() <= now.getTime();
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async processDueTriggers(): Promise<void> {
    const now = this.now();
    const allTriggers = await this.storage.findAllActiveCronTriggers();

    const dueTriggers = allTriggers.filter(
      (t) =>
        t.cron_expression &&
        AutomationCronWorker.isDue(t.cron_expression, t.last_run_at, now),
    );

    if (dueTriggers.length > 0) {
      console.log(
        `[AutomationCron] Found ${dueTriggers.length} due trigger(s) at ${now.toISOString()}:`,
        dueTriggers.map((t) => ({
          triggerId: t.id,
          automationId: t.automation_id,
          automationName: t.automation.name,
          cronExpr: t.cron_expression,
          lastRunAt: t.last_run_at,
          automationActive: t.automation.active,
        })),
      );
    }

    await Promise.allSettled(
      dueTriggers.map(({ automation, ...trigger }) =>
        this.fireTrigger(trigger, automation),
      ),
    );
  }

  private async fireTrigger(
    trigger: AutomationTrigger,
    automation: Automation,
  ): Promise<void> {
    console.log(
      `[AutomationCron] Firing trigger ${trigger.id} for automation "${automation.name}" (${automation.id})`,
    );

    // Record last_run_at FIRST (crash safety — if this fails, the trigger
    // fires again next cycle, which is safe)
    await this.storage.updateTriggerLastRunAt(
      trigger.id,
      this.now().toISOString(),
    );

    const result = await fireAutomation({
      automation,
      triggerId: trigger.id,
      storage: this.storage,
      streamCoreFn: this.streamCoreFn,
      meshContextFactory: this.meshContextFactory,
      config: this.config,
      globalSemaphore: this.globalSemaphore,
      deps: this.deps,
    });

    console.log(
      `[AutomationCron] fireAutomation result for trigger ${trigger.id}:`,
      result,
    );
  }
}
