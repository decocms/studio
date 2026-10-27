/**
 * ORGANIZATION_BILLING_GET — the org's Stripe binding as the plan settings
 * page needs it: whether a subscription owns the plan, and whether the
 * billing portal has something to open.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const ORGANIZATION_BILLING_GET = defineTool({
  name: "ORGANIZATION_BILLING_GET",
  description:
    "Get the organization's Stripe billing state: whether it has a subscription in good standing and a billing account.",
  annotations: {
    title: "Get Billing State",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    /** Active or past_due: Stripe's dunning grace still counts as paying. */
    subscribed: z.boolean(),
    /** Whether `ORGANIZATION_BILLING_PORTAL` has something to open. */
    hasBillingAccount: z.boolean(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);

    const billing = await ctx.storage.organizationBilling.getBilling(org.id);
    return {
      subscribed:
        billing?.status === "active" || billing?.status === "past_due",
      hasBillingAccount: !!billing?.stripeCustomerId,
    };
  },
});
