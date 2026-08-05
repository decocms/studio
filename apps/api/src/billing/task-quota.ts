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
 * A dispatch CHARGES the slot immediately (an org can never start more runs
 * than it could finish), and the charge is REFUNDED only when the run
 * demonstrably produced nothing — no pull request, the card never reached In
 * Review, and nothing else on the task still running. Those are durable facts
 * on the board, so the refund has one decision site (run-reactions.ts) and no
 * event to miss: a path that never reports "PR opened" simply stays charged,
 * which is the safe direction. Refunding is not a reset: the run tally
 * survives it, so the per-task cap still bounds retries.
 *
 * Periods need no cron: claims carry a `period_key` — "trial" while nothing
 * is being paid, else the subscription's current period end, which
 * invoice.paid refreshes, minting a fresh bucket each cycle.
 *
 * Both allowances default from the deployment env and are overridable per org
 * (`organization_billing.free_task_executions` / `monthly_task_executions`,
 * migration 164) for a tenant on different terms.
 *
 * Dormant unless STUDIO_TASK_QUOTA_ENFORCED is set (self-hosted stays free).
 */

import type { StudioContext } from "@/core/studio-context";
import { isReportsTask } from "@decocms/shared/task-board";
import { getSettings } from "../settings";
import type {
  OrganizationBillingRow,
  OrganizationBillingStorage,
} from "../storage/organization-billing";

export { isReportsTask };

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
 *
 * `limits` are the DEPLOYMENT defaults; the org's own columns (migration 164)
 * win when set, so one tenant can have a different ceiling without changing
 * anything about which bucket it lands in.
 */
export function taskQuotaState(
  billing:
    | (Pick<OrganizationBillingRow, "status" | "currentPeriodEnd"> &
        // Optional so a caller that omits them falls back to the deployment
        // default — the safe direction. Production passes the whole row, where
        // both columns are always present.
        Partial<
          Pick<
            OrganizationBillingRow,
            "freeTaskExecutions" | "monthlyTaskExecutions"
          >
        >)
    | null,
  limits: { freeTaskExecutions: number; monthlyTaskExecutions: number },
): TaskQuotaState {
  if (subscriptionInGoodStanding(billing)) {
    return {
      periodKey: billing?.currentPeriodEnd
        ? `sub:${billing.currentPeriodEnd.toISOString()}`
        : "sub:pending",
      limit: billing?.monthlyTaskExecutions ?? limits.monthlyTaskExecutions,
      exhaustedReason: "monthly_exhausted",
    };
  }
  return {
    periodKey: "trial",
    limit: billing?.freeTaskExecutions ?? limits.freeTaskExecutions,
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

export function taskQuotaConfig(): TaskQuotaConfig {
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
  const claim = await ctx.storage.organizationBilling.taskClaim(task.id);
  if (claim && claim.runCount >= config.maxRunsPerTask) {
    throw new TaskQuotaError("runs_exhausted");
  }
  // A live (held or committed) claim already owns its slot — re-runs are free
  // within the cap. A released one must re-take a slot, so fall through.
  if (claim && claim.state !== "released") return;
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
 *
 * Returns what it did, because only the caller knows whether the dispatch it
 * charged for actually started: `"claimed"` took a slot and is the ONLY
 * outcome a failed dispatch may roll back. `"rerun"` rode an earlier run's
 * slot — rolling that back would refund a run that really happened.
 */
export async function claimTaskExecution(
  ctx: StudioContext,
  task: GatedTask,
  config: TaskQuotaConfig = taskQuotaConfig(),
): Promise<"claimed" | "rerun" | "skipped"> {
  if (!config.enforced || !isReportsTask(task)) return "skipped";
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
  return result;
}

/**
 * Undo a charge whose dispatch never started — see `rollbackTaskClaim` for why
 * this differs from a refund. Only valid for a `"claimed"` outcome.
 *
 * Errors are swallowed: the caller is already unwinding a dispatch failure and
 * must re-throw THAT error, not this one.
 */
export async function rollbackTaskExecution(
  billing: OrganizationBillingStorage,
  organizationId: string,
  taskBoardItemId: string,
): Promise<void> {
  await billing
    .rollbackTaskClaim(organizationId, taskBoardItemId)
    .catch((err) =>
      console.error("[task-quota] rollback failed (stays charged)", err),
    );
}

/** Whether this task holds a CHARGED claim — the server-side fact the
 *  subsidized payer swap corroborates the run stamp against. A refunded claim
 *  doesn't authorize spending. */
export async function hasTaskQuotaClaim(
  ctx: StudioContext,
  taskBoardItemId: string,
): Promise<boolean> {
  const claim =
    await ctx.storage.organizationBilling.taskClaim(taskBoardItemId);
  return !!claim && claim.state !== "released";
}

/**
 * Refund a charged claim — the run produced nothing. The DECISION (no PR, card
 * below In Review, no live sibling run) belongs to the single site in
 * tools/task-board/run-reactions.ts; this only performs it.
 *
 * Deliberately NOT gated on `enforced`: with the gate off no claim exists, so
 * this touches nothing — and holds taken before the flag was turned off still
 * have to resolve.
 */
export async function releaseTaskExecution(
  billing: OrganizationBillingStorage,
  organizationId: string,
  taskBoardItemId: string,
): Promise<void> {
  await billing
    .releaseTaskClaim(organizationId, taskBoardItemId)
    .catch((err) =>
      console.error("[task-quota] refund failed (stays charged)", err),
    );
}
