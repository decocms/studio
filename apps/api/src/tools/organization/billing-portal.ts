/**
 * ORGANIZATION_BILLING_PORTAL — the self-serve management surface around the
 * org subscription: Stripe's hosted Customer Portal (card, invoices,
 * cancellation). We never build billing UI for what Stripe hosts; the
 * session returns to the members page.
 */

import { z } from "zod";
import {
  createBillingPortalSession,
  StripeApiError,
} from "../../billing/stripe-api";
import { getPublicUrl } from "../../core/server-constants";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const ORGANIZATION_BILLING_PORTAL = defineTool({
  name: "ORGANIZATION_BILLING_PORTAL",
  description:
    "Open the organization's Stripe billing portal (manage card, invoices, cancellation). Returns the portal URL.",
  annotations: {
    title: "Open Billing Portal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ url: z.string() }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    if (!org.slug) {
      throw new Error("Organization context required");
    }

    const billing = await ctx.storage.organizationBilling.getBilling(org.id);
    if (!billing?.stripeCustomerId) {
      throw new Error(
        "This organization has no billing account yet — subscribe first.",
      );
    }
    // deco-managed billing (legacy) must not self-serve cancellation or card
    // changes over a deco-owned customer.
    if (billing.legacy) {
      throw new Error(
        "This organization's billing is managed by deco — contact support.",
      );
    }

    try {
      return await createBillingPortalSession({
        customerId: billing.stripeCustomerId,
        // getPublicUrl: the browser follows this from Stripe's domain, so it
        // must be externally reachable, never a localhost fallback.
        returnUrl: `${getPublicUrl()}/${encodeURIComponent(org.slug)}/members`,
      });
    } catch (err) {
      if (err instanceof StripeApiError) throw new Error(err.message);
      throw err;
    }
  },
});
