/**
 * ORGANIZATION_TASK_QUOTA_GET — read-only view of the org's auto-task quota,
 * for the billing settings page (and, eventually, a pre-emptive "2 of 3 used"
 * indicator on the board — see `task-quota.ts`'s module doc). Composes the
 * same pure helpers the gate itself uses (`taskQuotaState`,
 * `countTaskClaims`), so this can never drift from what actually blocks a
 * delegation.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  subscriptionInGoodStanding,
  taskQuotaConfig,
  taskQuotaState,
} from "../../billing/task-quota";

export const ORGANIZATION_TASK_QUOTA_GET = defineTool({
  name: "ORGANIZATION_TASK_QUOTA_GET",
  description:
    "Get the organization's auto-task quota: how many runs are used in the current period, the limit, and the subscription's billing status.",
  annotations: {
    title: "Get Task Quota",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    /** Dormant unless STUDIO_TASK_QUOTA_ENFORCED — self-hosted deployments
     *  never gate, so the frontend should hide quota UI entirely. */
    enforced: z.boolean(),
    /** Raw Stripe-mirrored status ("none" when the org never subscribed). */
    billingStatus: z.string(),
    /** Whether `billingStatus` counts as paying (active or past_due — Stripe
     *  dunning grace still counts). */
    subscribed: z.boolean(),
    /** Whether `ORGANIZATION_BILLING_PORTAL` has something to open. */
    hasBillingAccount: z.boolean(),
    /** Runs used in the current period (trial or billing cycle). */
    used: z.number(),
    /** Runs allowed in the current period. */
    limit: z.number(),
    /** ISO end of the current billing cycle — null during the trial. */
    currentPeriodEnd: z.string().datetime().nullable(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);

    const config = taskQuotaConfig();
    const billing = await ctx.storage.organizationBilling.getBilling(org.id);
    const quota = taskQuotaState(billing, config);
    const used = await ctx.storage.organizationBilling.countTaskClaims(
      org.id,
      quota.periodKey,
    );

    return {
      enforced: config.enforced,
      billingStatus: billing?.status ?? "none",
      subscribed: subscriptionInGoodStanding(billing),
      hasBillingAccount: !!billing?.stripeCustomerId,
      used,
      limit: quota.limit,
      currentPeriodEnd: billing?.currentPeriodEnd?.toISOString() ?? null,
    };
  },
});
