/**
 * Task-execution quota — the monetization gate. Reports-pushed tasks
 * (created_by = "system", written only by the task-board import route) are
 * the ONLY gated thing: an org gets `freeTaskExecutions` lifetime trial
 * executions, then needs the org subscription, which grants
 * `monthlyTaskExecutions` per billing cycle. User-created tasks are never
 * gated (their AI runs bill through the org's configured provider).
 *
 * The unit is a TASK, not a run: the claim is keyed by task id, so review
 * bounces and conflict re-runs of an already-claimed task are free.
 * Periods need no cron: claims carry a `period_key` — "trial" while the
 * subscription isn't in good standing, else the current period end (which
 * invoice.paid refreshes, minting a fresh bucket each cycle).
 *
 * Dormant unless STUDIO_TASK_QUOTA_ENFORCED is set (self-hosted stays free).
 */

import type { StudioContext } from "@/core/studio-context";
import { getSettings } from "../settings";
import type { OrganizationBillingRow } from "../storage/organization-billing";

/**
 * The wire contract for the paywall UI — same convention as `[CREDITS]`
 * (web/components/chat/is-credit-error.ts): a stable message prefix that
 * survives every transport, detected by the frontend to render the
 * subscribe CTA instead of a generic error.
 */
export const SUBSCRIPTION_REQUIRED_PREFIX = "[SUBSCRIPTION_REQUIRED]";

export class TaskQuotaError extends Error {
  constructor(reason: "trial_exhausted" | "monthly_exhausted") {
    super(
      reason === "trial_exhausted"
        ? `${SUBSCRIPTION_REQUIRED_PREFIX} this organization used its free task executions — subscribe to keep running tasks`
        : `${SUBSCRIPTION_REQUIRED_PREFIX} this organization used its monthly task executions — more become available next billing cycle`,
    );
    this.name = "TaskQuotaError";
  }
}

/** Only reports-pushed tasks are gated. The import route is the sole writer
 *  of created_by = "system" (routes/task-board-import.ts); every user- or
 *  agent-created task carries a real principal id. */
export function isReportsTask(item: { createdBy: string }): boolean {
  return item.createdBy === "system";
}

/** `past_due` counts — Stripe dunning grace. A missing row or any other
 *  status means nobody is paying: the org is on the trial bucket. */
export function subscriptionInGoodStanding(
  billing: { status: string } | null,
): boolean {
  return billing?.status === "active" || billing?.status === "past_due";
}

export interface TaskQuotaState {
  periodKey: string;
  limit: number;
  /** Which error to throw when the limit is hit. */
  exhaustedReason: "trial_exhausted" | "monthly_exhausted";
}

/** Pure bucket selection: which period the next claim lands in and how many
 *  claims that bucket allows. */
export function taskQuotaState(
  billing: Pick<OrganizationBillingRow, "status" | "currentPeriodEnd"> | null,
  limits: { freeTaskExecutions: number; monthlyTaskExecutions: number },
): TaskQuotaState {
  if (subscriptionInGoodStanding(billing) && billing?.currentPeriodEnd) {
    return {
      periodKey: `sub:${billing.currentPeriodEnd.toISOString()}`,
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
}

function quotaConfig(): TaskQuotaConfig {
  const settings = getSettings();
  return {
    enforced: settings.taskQuotaEnforced,
    freeTaskExecutions: settings.freeTaskExecutions,
    monthlyTaskExecutions: settings.monthlyTaskExecutions,
  };
}

async function resolveGate(
  ctx: StudioContext,
  item: { createdBy: string },
  config: TaskQuotaConfig,
): Promise<{ organizationId: string; quota: TaskQuotaState } | null> {
  if (!config.enforced || !isReportsTask(item)) return null;
  const organizationId = ctx.organization?.id;
  if (!organizationId) return null;
  const billing =
    await ctx.storage.organizationBilling.getBilling(organizationId);
  return { organizationId, quota: taskQuotaState(billing, config) };
}

/**
 * Pre-write check for the delegation flip in TASK_BOARD_ITEM_UPDATE: throws
 * BEFORE anything persists, so the user sees the paywall and the task is not
 * left delegated-but-never-running. Advisory (unlocked read) — the atomic
 * claim at dispatch is the enforcement.
 */
export async function ensureTaskExecutionAllowed(
  ctx: StudioContext,
  item: { id: string; createdBy: string },
  config: TaskQuotaConfig = quotaConfig(),
): Promise<void> {
  const gate = await resolveGate(ctx, item, config);
  if (!gate) return;
  // An already-claimed task (review bounce, conflict re-run) is always free.
  if (await ctx.storage.organizationBilling.hasTaskClaim(item.id)) return;
  const used = await ctx.storage.organizationBilling.countTaskClaims(
    gate.organizationId,
    gate.quota.periodKey,
  );
  if (used >= gate.quota.limit) {
    throw new TaskQuotaError(gate.quota.exhaustedReason);
  }
}

/**
 * The consumption point, called at dispatch (enqueueSuperAgentForTask) so
 * every path into execution — update flip, import auto-delegation, stall
 * recovery — funnels through it. The claim is ATOMIC per org (the storage
 * transaction locks the billing row before counting), so a burst of N
 * concurrent dispatches consumes exactly the remaining slots and the rest
 * get the paywall — the quota can't be raced past.
 */
export async function claimTaskExecution(
  ctx: StudioContext,
  item: { id: string; createdBy: string },
  config: TaskQuotaConfig = quotaConfig(),
): Promise<void> {
  const gate = await resolveGate(ctx, item, config);
  if (!gate) return;
  const result = await ctx.storage.organizationBilling.claimTaskUnderLimit(
    gate.organizationId,
    item.id,
    gate.quota.periodKey,
    gate.quota.limit,
  );
  if (result === "exhausted") {
    throw new TaskQuotaError(gate.quota.exhaustedReason);
  }
}
