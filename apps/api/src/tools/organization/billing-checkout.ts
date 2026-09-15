/**
 * ORGANIZATION_BILLING_CHECKOUT_START — subscribe, or move an existing
 * subscription to another tier.
 *
 * Two Stripe-hosted surfaces behind one tool, because the caller's question is
 * the same either way ("put this org on this plan") and the answer is always a
 * URL to send them to:
 *   - no subscription → Checkout (collects the card, quantity 1)
 *   - a live subscription → the portal's subscription-update confirm flow
 * Completion comes back via the webhook in both cases.
 */

import { z } from "zod";
import {
  createOrgCheckoutSession,
  createSubscriptionUpdateSession,
  priceIdForPlan,
  retrieveSubscription,
  StripeApiError,
} from "../../billing/stripe-api";
import { orgSettingsPath } from "@decocms/shared/organization-paths";
import { getPublicUrl } from "../../core/server-constants";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { captureOrgEvent } from "@/posthog";

export const ORGANIZATION_BILLING_CHECKOUT_START = defineTool({
  name: "ORGANIZATION_BILLING_CHECKOUT_START",
  description:
    "Start the organization's subscription: creates a Stripe Checkout session and returns its URL.",
  annotations: {
    title: "Start Billing Checkout",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    /** The tier to buy. Its price must be in STRIPE_PLAN_PRICE_IDS, which is
     *  what makes a paid tier purchasable rather than merely requestable —
     *  `AI_PLAN_SET` takes no payment and refuses upgrades for that reason. */
    planId: z.string().optional(),
  }),
  outputSchema: z.object({
    url: z.string(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    const orgSlug = ctx.organization?.slug;
    if (!organizationId || !orgSlug) {
      throw new Error("Organization context required");
    }

    const billing =
      await ctx.storage.organizationBilling.getBilling(organizationId);

    // getPublicUrl: the browser follows these from Stripe's domain, so they
    // must be externally reachable, never a localhost fallback.
    const membersUrl = `${getPublicUrl()}${orgSettingsPath(orgSlug, "members")}`;

    // A BOUND subscription rules out Checkout: a second checkout is a second
    // subscription the webhook then refuses to bind, i.e. a double charge.
    // Moving the subscription already on file to another price is the only
    // safe way to change tier, and Stripe hosts the confirmation for it.
    //
    // Only from `active`. A subscription in dunning has an unpaid invoice, and
    // a tier change there stacks a proration on top of a debt the org has
    // already failed to settle — the tier it ends on then depends on which of
    // the two invoices clears. Recovery stays Stripe-side, as before.
    if (billing?.status === "active" && billing.stripeSubscriptionId) {
      const url = await startPlanChange({
        subscriptionId: billing.stripeSubscriptionId,
        planId: input.planId,
        returnUrl: `${membersUrl}?checkout=updated`,
      });
      captureOrgEvent({
        event: "subscription_plan_change_started",
        organizationId,
        ...(input.planId ? { properties: { plan_id: input.planId } } : {}),
        ...(ctx.auth?.user?.id ? { userId: ctx.auth.user.id } : {}),
      });
      return { url };
    }
    if (billing?.status === "active") {
      throw new Error("This organization already has an active subscription.");
    }
    // Recovery is Stripe-side (invoice settles → reactivates, and the tier
    // change reopens; deletion → unbinds, checkout reopens).
    if (billing?.stripeSubscriptionId) {
      throw new Error(
        "This organization still has a subscription on file — settle or cancel it before starting a new checkout.",
      );
    }

    const { url } = await createOrgCheckoutSession({
      organizationId,
      successUrl: `${membersUrl}?checkout=success`,
      cancelUrl: `${membersUrl}?checkout=canceled`,
      ...(input.planId ? { planId: input.planId } : {}),
    });
    // Intent half of the funnel — completion (subscription_started) arrives via webhook.
    captureOrgEvent({
      event: "subscription_checkout_started",
      organizationId,
      ...(input.planId ? { properties: { plan_id: input.planId } } : {}),
      ...(ctx.auth?.user?.id ? { userId: ctx.auth.user.id } : {}),
    });
    return { url };
  },
});

/**
 * The Stripe side of a tier change on a subscription that already exists.
 *
 * Refuses rather than guesses at every step: no plan named, no price mapped to
 * it, or a subscription Stripe no longer reports an item for. Each of those
 * would otherwise end as a portal session pointed at nothing, or — worse — at
 * the wrong price.
 */
async function startPlanChange(input: {
  subscriptionId: string;
  planId: string | undefined;
  returnUrl: string;
}): Promise<string> {
  if (!input.planId) {
    throw new Error("This organization already has an active subscription.");
  }
  const priceId = priceIdForPlan(input.planId);
  if (!priceId) {
    throw new StripeApiError(
      503,
      `plan '${input.planId}' has no Stripe price configured`,
    );
  }
  const subscription = await retrieveSubscription(input.subscriptionId);
  const item = subscription.items?.data?.[0];
  if (!item?.id) {
    throw new StripeApiError(
      500,
      "subscription has no item to move to another price",
    );
  }
  // Already there — a confirm screen offering the price it is on would read as
  // a second charge for the plan they have.
  if (item.price?.id === priceId) {
    throw new Error("This organization is already on that plan.");
  }
  const { url } = await createSubscriptionUpdateSession({
    customerId: subscription.customer,
    subscriptionId: input.subscriptionId,
    subscriptionItemId: item.id,
    priceId,
    returnUrl: input.returnUrl,
  });
  return url;
}
