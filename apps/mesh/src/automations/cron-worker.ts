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
import type { AutomationJobPayload } from "./job-stream";

export type PublishFn = (payload: AutomationJobPayload) => Promise<void>;

/**
 * Zombie runs are threads created by tryAcquireRunSlot that never got picked
 * up by streamCore (e.g. pod crashed between thread creation and RUN_STARTED).
 * They have status=in_progress but no run_config, so orphan recovery cannot
 * find them — they permanently block per-automation concurrency slots.
 */
const ZOMBIE_RUN_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export class AutomationCronWorker {
  private running = false;
  private processing = false;
  private pendingNotify = false;

  constructor(
    private storage: AutomationsStorage,
    private publishJob: PublishFn,
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
    for (const t of triggers) {
      if (!t.cron_expression) continue;
      const after = t.last_run_at
        ? new Date(t.last_run_at)
        : new Date(t.created_at);
      const nextRun = AutomationCronWorker.computeNextRunAt(
        t.cron_expression,
        after,
      );
      await this.storage.updateNextRunAt(
        t.id,
        nextRun ? nextRun.toISOString() : null,
      );
    }
  }

  private async processDueTriggers(): Promise<void> {
    // Sweep zombie runs before processing triggers so freed concurrency
    // slots are immediately available for the current batch.
    try {
      const reaped = await this.storage.failZombieAutomationRuns(
        ZOMBIE_RUN_MAX_AGE_MS,
      );
      if (reaped > 0) {
        console.warn(
          `[AutomationCronWorker] Force-failed ${reaped} zombie automation run(s)`,
        );
      }
    } catch (err) {
      console.error("[AutomationCronWorker] Zombie run cleanup failed:", err);
    }

    const now = this.now();
    const batchSize = 20;

    const dueTriggers = await this.storage.findDueCronTriggers(now, batchSize);

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
      await this.storage.updateNextRunAt(
        trigger.id,
        nextRun ? nextRun.toISOString() : null,
      );
    }

    // 3. Publish to JetStream for worker execution
    await this.publishJob(payload);
  }
}
