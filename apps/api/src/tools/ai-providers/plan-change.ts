import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { HOSTED_PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { getProviders } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";
import { invalidateOrgFeaturesCache } from "../../core/plan-feature-gate";

const planSchema = z.object({
  id: z.string(),
  name: z.string(),
  features: z.record(z.string(), z.boolean()),
});

export const AI_PLAN_LIST = defineTool({
  name: "AI_PLAN_LIST",
  description: "List the plans an organization can move to",
  inputSchema: z.object({ providerId: z.enum(HOSTED_PROVIDER_IDS) }),
  outputSchema: z.object({ plans: z.array(planSchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const adapter = getProviders()[input.providerId];
    if (!adapter?.listPlans) {
      throw new Error(`Provider ${input.providerId} does not expose plans`);
    }
    const studioJwt = await mintGatewayJwt(userId);
    return { plans: await adapter.listPlans(studioJwt, org.id) };
  },
});

/**
 * Drops the org back to the free tier. It cannot grant a paid one.
 *
 * This took ANY plan id once, and took no payment for it — so an org admin
 * could open the plan picker, click Ultra, and receive every gated feature and
 * a $400 monthly AI allowance for nothing. The gateway route behind it says as
 * much in its own comment ("mesh owns the role check and the payment that must
 * precede this call"); mesh owned the role check and never the payment.
 *
 * A paid tier is now granted by exactly one thing: a Stripe subscription whose
 * price is in STRIPE_PLAN_PRICE_IDS, applied by the webhook. Upgrades go
 * through ORGANIZATION_BILLING_CHECKOUT_START, and an operator placing a plan
 * by hand goes through the gateway's admin API, which is admin-token gated.
 *
 * Downgrading is refused too while a subscription is bound: cancelling at the
 * gateway would strip the features while Stripe kept charging for them. That
 * cancellation belongs in Stripe's customer portal, and its
 * `subscription.deleted` comes back here as a plan change to free.
 */
export const AI_PLAN_SET = defineTool({
  name: "AI_PLAN_SET",
  description:
    "Drop the organization back to the free tier. Paid plans are granted by subscribing (ORGANIZATION_BILLING_CHECKOUT_START), never here.",
  inputSchema: z.object({
    providerId: z.enum(HOSTED_PROVIDER_IDS),
    planId: z.literal("free"),
  }),
  outputSchema: z.object({
    plan: z.object({ id: z.string(), name: z.string() }),
    features: z.record(z.string(), z.boolean()),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    // A live subscription is Stripe's to end. Dropping the plan here would
    // take the features away and leave the card being charged for them.
    const billing = await ctx.storage.organizationBilling.getBilling(org.id);
    if (billing?.stripeSubscriptionId) {
      throw new Error(
        "This organization has an active subscription — cancel it in billing first; the plan drops to free when it ends.",
      );
    }

    const adapter = getProviders()[input.providerId];
    if (!adapter?.setPlan) {
      throw new Error(`Provider ${input.providerId} does not expose plans`);
    }
    const studioJwt = await mintGatewayJwt(userId);
    const result = await adapter.setPlan(studioJwt, org.id, input.planId);
    // Drop the gate's cached features so the very next tool call sees the new
    // plan. Without this an upgrade appears to do nothing for up to a minute —
    // the user switches to Ultra and the feature they just bought is still
    // refused. Only this instance; other pods still wait out their TTL.
    invalidateOrgFeaturesCache(org.id);
    return { plan: result.plan, features: result.features };
  },
});
