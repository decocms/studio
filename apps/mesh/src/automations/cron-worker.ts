/**
 * Automation Cron Scheduler
 *
 * Periodically queries for due cron triggers using an indexed `next_run_at`
 * column and publishes fire commands to NATS JetStream. Workers pull jobs
 * from the stream and execute them independently.
 *
 * Crash-safe design:
 * - `last_run_at` is the source of truth (updated FIRST before dispatch)
 * - `next_run_at` is a denormalized cache for indexed queries
 * - On startup, a sweep recomputes any stale `next_run_at` values
 * - `FOR UPDATE SKIP LOCKED` enables multi-instance scheduling
 *
 * Follows the same coalescing-loop pattern as EventBusWorker:
 *   - `processNow()` is called by an external timer / polling strategy
 *   - Concurrent calls are coalesced so at most one `processDueTriggers`
 *     runs at a time, with a follow-up if notifications arrived mid-flight.
 */

import type { AutomationsStorage } from "@/storage/automations";
import type { AutomationTrigger } from "@/storage/types";
import { Cron } from "croner";
import type { AutomationJobStream, AutomationJobPayload } from "./job-stream";

export class AutomationCronWorker {
  private running = false;
  private processing = false;
  private pendingNotify = false;

  constructor(
    private storage: AutomationsStorage,
    private jobStream: AutomationJobStream,
    private now: () => Date = () => new Date(),
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await this.recomputeStaleNextRunAt();
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
   * Compute the next run time after `after` for a given cron expression.
   */
  static computeNextRunAt(cronExpression: string, after: Date): Date | null {
    try {
      const cron = new Cron(cronExpression, { timezone: "UTC" });
      return cron.nextRun(after) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a cron trigger is due based on its expression and last_run_at.
   * Kept for backward compatibility and tests.
   */
  static isDue(
    cronExpression: string,
    lastRunAt: string | null,
    now: Date,
  ): boolean {
    try {
      const cron = new Cron(cronExpression, { timezone: "UTC" });
      if (!lastRunAt) return true;
      const nextScheduled = cron.nextRun(new Date(lastRunAt));
      return nextScheduled != null && nextScheduled.getTime() <= now.getTime();
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * On startup, recompute next_run_at for all active cron triggers.
   * Fixes any stale values from crashes or missed updates.
   */
  private async recomputeStaleNextRunAt(): Promise<void> {
    const triggers = await this.storage.findAllCronTriggersForRecompute();
    let updated = 0;

    for (const t of triggers) {
      if (!t.cron_expression) continue;
      const after = t.last_run_at
        ? new Date(t.last_run_at)
        : new Date(t.created_at);
      const nextRun = AutomationCronWorker.computeNextRunAt(
        t.cron_expression,
        after,
      );
      if (nextRun) {
        await this.storage.updateNextRunAt(t.id, nextRun.toISOString());
        updated++;
      }
    }

    if (updated > 0) {
      console.log(
        `[AutomationCron] Startup sweep: recomputed next_run_at for ${updated} trigger(s)`,
      );
    }
  }

  private async processDueTriggers(): Promise<void> {
    const now = this.now();
    const batchSize = 20;

    const dueTriggers = await this.storage.findDueCronTriggers(now, batchSize);

    if (dueTriggers.length > 0) {
      console.log(
        `[AutomationCron] Found ${dueTriggers.length} due trigger(s) at ${now.toISOString()}:`,
        dueTriggers.map((t) => ({
          triggerId: t.id,
          automationId: t.automation_id,
          automationName: t.automation.name,
          cronExpr: t.cron_expression,
          lastRunAt: t.last_run_at,
        })),
      );
    }

    await Promise.allSettled(
      dueTriggers.map(({ automation, ...trigger }) =>
        this.dispatchTrigger(trigger, {
          triggerId: trigger.id,
          automationId: automation.id,
          organizationId: automation.organization_id,
        }),
      ),
    );
  }

  private async dispatchTrigger(
    trigger: AutomationTrigger,
    payload: AutomationJobPayload,
  ): Promise<void> {
    const now = this.now();

    // 1. Update last_run_at FIRST (crash-safe: if this fails, trigger fires again)
    await this.storage.updateTriggerLastRunAt(trigger.id, now.toISOString());

    // 2. Compute and store next_run_at (cache update, best-effort)
    if (trigger.cron_expression) {
      const nextRun = AutomationCronWorker.computeNextRunAt(
        trigger.cron_expression,
        now,
      );
      if (nextRun) {
        await this.storage.updateNextRunAt(trigger.id, nextRun.toISOString());
      }
    }

    // 3. Publish to JetStream for worker execution
    console.log(
      `[AutomationCron] Dispatching trigger ${trigger.id} for automation ${payload.automationId}`,
    );
    await this.jobStream.publish(payload);
  }
}
