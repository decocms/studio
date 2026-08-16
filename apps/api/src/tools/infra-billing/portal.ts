/**
 * INFRA_BILLING_PORTAL — Stripe's hosted Customer Portal for the legacy team
 * that owns this site. Same Stripe account as Studio's own subscription, so it
 * reuses `stripe-api.ts`; the session returns to the Infra Billing page.
 */

import { z } from "zod";
import {
  createBillingPortalSession,
  retrieveSubscription,
  StripeApiError,
} from "../../billing/stripe-api";
import { defineTool } from "../../core/define-tool";
import { getPublicUrl } from "../../core/server-constants";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  resolveTeamId,
  teamStripeSubscriptionId,
} from "../../deco-legacy/infra-billing";

export const INFRA_BILLING_PORTAL = defineTool({
  name: "INFRA_BILLING_PORTAL",
  description:
    "Open the Stripe billing portal for the legacy deco.cx team that owns a site this organization owns. Returns the portal URL.",
  annotations: {
    title: "Open Infra Billing Portal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({ siteSlug: z.string().min(1).max(60) }),
  outputSchema: z.object({ url: z.string() }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    if (!org.slug) {
      throw new Error("Organization context required");
    }

    const slug = input.siteSlug.toLowerCase();
    if (!(await ctx.storage.orgSites.isOwnedBy(slug, org.id))) {
      throw new Error(`Site not found in organization: ${slug}`);
    }

    const teamId = await resolveTeamId(slug);
    const subscriptionId =
      teamId === null ? null : await teamStripeSubscriptionId(teamId);
    if (!subscriptionId) {
      throw new Error("This site has no Stripe subscription to manage.");
    }

    try {
      const subscription = await retrieveSubscription(subscriptionId);
      return await createBillingPortalSession({
        customerId: subscription.customer,
        // Followed from Stripe's domain, so it must be externally reachable.
        returnUrl: `${getPublicUrl()}/${encodeURIComponent(org.slug)}/settings/infra-billing`,
      });
    } catch (err) {
      if (err instanceof StripeApiError) throw new Error(err.message);
      throw err;
    }
  },
});
