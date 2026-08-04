/**
 * Task-execution quota — the monetization gate. Reports-pushed tasks
 * (created_by = "system", written only by the task-board import route) are
 * the ONLY gated thing: an org gets `freeTaskExecutions` lifetime trial
 * executions, then needs the org subscription, which grants
 * `monthlyTaskExecutions` per billing cycle. User-created tasks are never
 * gated (their AI runs bill through the org's configured provider).
 *
 * The billed unit is a TASK, not a run: the claim is keyed by task id, so
 * review bounces and conflict re-runs of an already-claimed task cost no
 * quota — bounded by `maxRunsPerTask`, because a claimed task can be
 * re-delegated in a loop and each dispatch spends real (subsidized) money.
 *
 * Periods need no cron: claims carry a `period_key` — "trial" while nothing
 * is being paid, else the subscription's current period end, which
 * invoice.paid refreshes, minting a fresh bucket each cycle.
 *
 * Dormant unless STUDIO_TASK_QUOTA_ENFORCED is set (self-hosted stays free).
 */

import type { StudioContext } from "@/core/studio-context";
import { getSettings } from "../settings";
import type { OrganizationBillingRow } from "../storage/organization-billing";

/**
 * The wire contract for the paywall UI — same convention as `[CREDITS]`
 * (web/components/chat/is-credit-error.ts): a stable message prefix that
 * survives every transport. The frontend detector is follow-up work (it
 * ships with the billing UI); until then a blocked user sees this text.
 */
export const SUBSCRIPTION_REQUIRED_PREFIX = "[SUBSCRIPTION_REQUIRED]";

export type TaskQuotaReason =
  | "trial_exhausted"
  | "monthly_exhausted"
  | "runs_exhausted";

const QUOTA_MESSAGES: Record<TaskQuotaReason, string> = {
  trial_exhausted:
    "this organization used its free task executions — subscribe to keep running tasks",
  monthly_exhausted:
    "this organization used its monthly task executions — more become available next billing cycle",
  runs_exhausted:
    "this task reached its execution limit — create a new task to keep going",
};

export class TaskQuotaError extends Error {
  constructor(readonly reason: TaskQuotaReason) {
    super(`${SUBSCRIPTION_REQUIRED_PREFIX} ${QUOTA_MESSAGES[reason]}`);
    this.name = "TaskQuotaError";
  }
}

/** Only reports-pushed tasks are gated. The import route is the sole writer
 *  of created_by = "system" (routes/task-board-import.ts); every user- or
 *  agent-created task carries a real principal id. */
export function isReportsTask(item: { createdBy: string }): boolean {
  return item.createdBy === "system";
}

/** `past_due` counts — Stripe dunning grace. */
export function subscriptionInGoodStanding(
  billing: { status: string } | null,
): boolean {
  return billing?.status === "active" || billing?.status === "past_due";
}

export interface TaskQuotaState {
  periodKey: string;
  limit: number;
  /** Which error to throw when the period bucket is full. */
  exhaustedReason: TaskQuotaReason;
}

/**
 * Pure bucket selection: which period the next claim lands in and how many
 * claims that bucket allows.
 *
 * A paying org whose `current_period_end` hasn't landed yet gets its own
 * `sub:pending` bucket with the MONTHLY limit — never the (already spent)
 * trial bucket. checkout.session.completed flips status to active without a
 * period end, and the invoice.paid that carries one can arrive before the
 * bind (acked as "unknown subscription", never redelivered), so the window
 * can last a full cycle. Paywalling a customer who just paid is worse.
 */
export function taskQuotaState(
  billing: Pick<OrganizationBillingRow, "status" | "currentPeriodEnd"> | null,
  limits: { freeTaskExecutions: number; monthlyTaskExecutions: number },
): TaskQuotaState {
  if (subscriptionInGoodStanding(billing)) {
    return {
      periodKey: billing?.currentPeriodEnd
        ? `sub:${billing.currentPeriodEnd.toISOString()}`
        : "sub:pending",
      limit: limits.monthlyTaskExecutions,
      exhaustedReason: "monthly_exhausted",
    };
  }
  return {
    periodKey: "trial",
    limit: limits.freeTaskExecutions,
    exhaustedReason: "trial_exhausted",
  };
}

/** Injectable seam (integration tests pass explicit values; production
 *  defaults come from settings — global, frozen at boot). */
export interface TaskQuotaConfig {
  enforced: boolean;
  freeTaskExecutions: number;
  monthlyTaskExecutions: number;
  maxRunsPerTask: number;
}

function taskQuotaConfig(): TaskQuotaConfig {
  const settings = getSettings();
  return {
    enforced: settings.taskQuotaEnforced,
    freeTaskExecutions: settings.freeTaskExecutions,
    monthlyTaskExecutions: settings.monthlyTaskExecutions,
    maxRunsPerTask: settings.maxRunsPerTask,
  };
}

/** The org a task's quota belongs to is the TASK's org, never the ambient
 *  context's — a ctx/task mismatch must not claim under the wrong org. */
interface GatedTask {
  id: string;
  createdBy: string;
  organizationId: string;
}

/**
 * Pre-write check for the delegation flip in TASK_BOARD_ITEM_UPDATE: throws
 * BEFORE anything persists, so the user sees the paywall instead of a task
 * that looks delegated. Advisory only — it claims nothing, and the
 * transactional claim at dispatch is the enforcement (a concurrent flip can
 * still take the last slot; that rejection surfaces from the dispatch).
 */
export async function ensureTaskExecutionAllowed(
  ctx: StudioContext,
  task: GatedTask,
  config: TaskQuotaConfig = taskQuotaConfig(),
): Promise<void> {
  if (!config.enforced || !isReportsTask(task)) return;
  const existingRuns = await ctx.storage.organizationBilling.taskRunCount(
    task.id,
  );
  if (existingRuns !== null) {
    // Already claimed — re-runs are free within the per-task cap.
    if (existingRuns >= config.maxRunsPerTask) {
      throw new TaskQuotaError("runs_exhausted");
    }
    return;
  }
  const billing = await ctx.storage.organizationBilling.getBilling(
    task.organizationId,
  );
  const quota = taskQuotaState(billing, config);
  const used = await ctx.storage.organizationBilling.countTaskClaims(
    task.organizationId,
    quota.periodKey,
  );
  if (used >= quota.limit) throw new TaskQuotaError(quota.exhaustedReason);
}

/**
 * The consumption point, called at dispatch (enqueueSuperAgentForTask) so
 * every path into execution — update flip, import auto-delegation,
 * review/conflict re-runs — funnels through it, for BOTH harnesses. The
 * claim is atomic per org (the storage transaction locks the billing row),
 * so a burst of concurrent dispatches consumes exactly the remaining slots.
 */
export async function claimTaskExecution(
  ctx: StudioContext,
  task: GatedTask,
  config: TaskQuotaConfig = taskQuotaConfig(),
): Promise<void> {
  if (!config.enforced || !isReportsTask(task)) return;
  const billing = await ctx.storage.organizationBilling.getBilling(
    task.organizationId,
  );
  const quota = taskQuotaState(billing, config);
  const result = await ctx.storage.organizationBilling.claimTaskUnderLimit(
    task.organizationId,
    task.id,
    quota.periodKey,
    quota.limit,
    config.maxRunsPerTask,
  );
  if (result === "exhausted") throw new TaskQuotaError(quota.exhaustedReason);
  if (result === "runs_exhausted") throw new TaskQuotaError("runs_exhausted");
}

/** Whether this task has a quota claim — the server-side fact the subsidized
 *  payer swap corroborates the run stamp against. */
export async function hasTaskQuotaClaim(
  ctx: StudioContext,
  taskBoardItemId: string,
): Promise<boolean> {
  return (
    (await ctx.storage.organizationBilling.taskRunCount(taskBoardItemId)) !==
    null
  );
}
