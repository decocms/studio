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
    if (!this.running) {
      console.log("[AutomationCron] processNow skipped: worker not running");
      return;
    }
    if (this.processing) {
      console.log(
        "[AutomationCron] processNow coalesced: already processing, will re-run after",
      );
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
    console.log(
      `[AutomationCron] Startup sweep: found ${triggers.length} active cron trigger(s) to check`,
    );
    let updated = 0;

    for (const t of triggers) {
      if (!t.cron_expression) {
        console.log(
          `[AutomationCron] Startup sweep: trigger ${t.id} has no cron_expression, skipping`,
        );
        continue;
      }
      const after = t.last_run_at
        ? new Date(t.last_run_at)
        : new Date(t.created_at);
      const nextRun = AutomationCronWorker.computeNextRunAt(
        t.cron_expression,
        after,
      );
      console.log(
        `[AutomationCron] Startup sweep: trigger ${t.id} cron="${t.cron_expression}" last_run_at=${t.last_run_at ?? "null"} → next_run_at=${nextRun?.toISOString() ?? "null"}`,
      );
      await this.storage.updateNextRunAt(
        t.id,
        nextRun ? nextRun.toISOString() : null,
      );
      updated++;
    }

    console.log(
      `[AutomationCron] Startup sweep complete: recomputed ${updated}/${triggers.length} trigger(s)`,
    );
  }

  private async processDueTriggers(): Promise<void> {
    const now = this.now();
    const batchSize = 20;

    // DEBUG: dump raw state of all cron triggers before filtering
    const allTriggers = await this.storage.findAllCronTriggersForRecompute();
    if (allTriggers.length > 0) {
      console.log(
        `[AutomationCron] DEBUG all cron triggers in DB (${allTriggers.length}):`,
        allTriggers.map((t) => ({
          id: t.id,
          cron: t.cron_expression,
          last_run_at: t.last_run_at,
          next_run_at: t.next_run_at,
          next_run_at_type: typeof t.next_run_at,
          created_at: t.created_at,
        })),
      );
    }

    const nowIso = now.toISOString();
    console.log(
      `[AutomationCron] Polling for due triggers at ${nowIso} (WHERE next_run_at <= '${nowIso}')`,
    );

    const dueTriggers = await this.storage.findDueCronTriggers(now, batchSize);

    console.log(
      `[AutomationCron] Query returned ${dueTriggers.length} due trigger(s)`,
    );

    if (dueTriggers.length > 0) {
      console.log(
        `[AutomationCron] Due triggers:`,
        dueTriggers.map((t) => ({
          triggerId: t.id,
          automationId: t.automation_id,
          automationName: t.automation.name,
          cronExpr: t.cron_expression,
          lastRunAt: t.last_run_at,
          nextRunAt: t.next_run_at,
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
    console.log(
      `[AutomationCron] Dispatch step 1: updating last_run_at=${now.toISOString()} for trigger ${trigger.id}`,
    );
    await this.storage.updateTriggerLastRunAt(trigger.id, now.toISOString());

    // 2. Compute and store next_run_at (cache update, best-effort)
    if (trigger.cron_expression) {
      const nextRun = AutomationCronWorker.computeNextRunAt(
        trigger.cron_expression,
        now,
      );
      console.log(
        `[AutomationCron] Dispatch step 2: next_run_at=${nextRun?.toISOString() ?? "null"} for trigger ${trigger.id}`,
      );
      await this.storage.updateNextRunAt(
        trigger.id,
        nextRun ? nextRun.toISOString() : null,
      );
    }

    // 3. Publish to JetStream for worker execution
    console.log(
      `[AutomationCron] Dispatch step 3: publishing to JetStream for trigger ${trigger.id} automation ${payload.automationId}`,
    );
    await this.jobStream.publish(payload);
    console.log(`[AutomationCron] Dispatch complete for trigger ${trigger.id}`);
  }
}
