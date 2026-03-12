/**
 * Automation Cron Worker
 *
 * Periodically finds due cron triggers and fires the associated automations.
 * Follows the same coalescing-loop pattern as EventBusWorker:
 *   - `processNow()` is called by an external timer / polling strategy
 *   - Concurrent calls are coalesced so at most one `processDueTriggers`
 *     runs at a time, with a follow-up if notifications arrived mid-flight.
 *
 * On startup the worker recovers all cron triggers by recomputing their
 * `next_run_at` from the cron expression, protecting against stale or
 * NULL values left by a previous crash.
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
    await this.recoverMissedCronTriggers();
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
  // Private helpers
  // --------------------------------------------------------------------------

  private async processDueTriggers(): Promise<void> {
    const now = this.now().toISOString();
    const dueTriggers = await this.storage.findDueCronTriggers(now);

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
    // Schedule next run FIRST (crash safety)
    await this.scheduleNextRun(trigger);

    await fireAutomation({
      automation,
      triggerId: trigger.id,
      storage: this.storage,
      streamCoreFn: this.streamCoreFn,
      meshContextFactory: this.meshContextFactory,
      config: this.config,
      globalSemaphore: this.globalSemaphore,
      deps: this.deps,
    });
  }

  private async scheduleNextRun(trigger: AutomationTrigger): Promise<void> {
    if (!trigger.cron_expression) return;
    try {
      const cron = new Cron(trigger.cron_expression);
      const nextRun = cron.nextRun();
      if (nextRun) {
        await this.storage.updateTriggerNextRunAt(
          trigger.id,
          nextRun.toISOString(),
        );
      }
    } catch (err) {
      console.error(
        `[AutomationCron] Failed to compute next run for trigger ${trigger.id}:`,
        err,
      );
    }
  }

  /**
   * Recover all cron triggers on startup by recomputing `next_run_at`.
   * Uses a far-future timestamp so `findDueCronTriggers` returns every
   * active cron trigger, not just those that are overdue right now.
   */
  private async recoverMissedCronTriggers(): Promise<void> {
    try {
      const now = this.now();
      const allDue = await this.storage.findDueCronTriggers(
        new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      );

      for (const { automation: _automation, ...trigger } of allDue) {
        if (!trigger.cron_expression) continue;
        try {
          const cron = new Cron(trigger.cron_expression);
          const nextRun = cron.nextRun();
          if (nextRun) {
            await this.storage.updateTriggerNextRunAt(
              trigger.id,
              nextRun.toISOString(),
            );
          }
        } catch {
          // Skip triggers with invalid cron expressions
        }
      }
      console.log(`[AutomationCron] Recovered ${allDue.length} cron triggers`);
    } catch (err) {
      console.error(
        "[AutomationCron] Error recovering missed cron triggers:",
        err,
      );
    }
  }
}
