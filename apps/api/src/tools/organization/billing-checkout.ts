/**
 * ORGANIZATION_BILLING_CHECKOUT_START — first subscribe for the per-org
 * subscription (one flat monthly price, quantity 1). Creates the Stripe
 * Checkout session; completion comes back via the webhook (binds the
 * subscription, flips status). The ONE redirect in the org's life —
 * afterwards Stripe's Customer Portal manages everything.
 */

import { z } from "zod";
import { createOrgCheckoutSession } from "../../billing/stripe-api";
import { getPublicUrl } from "../../core/server-constants";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";

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
  inputSchema: z.object({}),
  outputSchema: z.object({
    url: z.string(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    const orgSlug = ctx.organization?.slug;
    if (!organizationId || !orgSlug) {
      throw new Error("Organization context required");
    }

    const billing =
      await ctx.storage.organizationBilling.getBilling(organizationId);
    if (billing?.legacy) {
      throw new Error(
        "This organization is on the legacy plan — no subscription needed.",
      );
    }
    if (billing?.status === "active") {
      throw new Error("This organization already has an active subscription.");
    }
    // A BOUND subscription blocks checkout even when status isn't active:
    // past_due (dunning) and unpaid/paused (mapped to canceled WITHOUT
    // unbinding) all mean a live subscription still exists on Stripe — a
    // second checkout would charge the customer for a subscription the
    // webhook then refuses to bind (orphan). Recovery is Stripe-side: settle
    // the invoice (invoice.paid reactivates) or let Stripe delete the
    // subscription (deleted unbinds, and checkout opens up again).
    if (billing?.stripeSubscriptionId) {
      throw new Error(
        "This organization still has a subscription on file — settle or cancel it before starting a new checkout.",
      );
    }

    // getPublicUrl: the browser follows these from Stripe's domain, so they
    // must be externally reachable, never a localhost fallback.
    const membersUrl = `${getPublicUrl()}/${encodeURIComponent(orgSlug)}/members`;
    const { url } = await createOrgCheckoutSession({
      organizationId,
      successUrl: `${membersUrl}?checkout=success`,
      cancelUrl: `${membersUrl}?checkout=canceled`,
    });
    return { url };
  },
});
