/**
 * INFRA_BILLING_PORTAL — Stripe's hosted Customer Portal for the legacy team
 * that owns this site. Same Stripe account as Studio's own subscription, so it
 * reuses `stripe-api.ts`; the session returns to the Infra Billing page.
 */

import { z } from "zod";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import {
  createBillingPortalSession,
  retrieveSubscription,
  StripeApiError,
} from "../../billing/stripe-api";
import { defineTool } from "../../core/define-tool";
import { getPublicUrl } from "../../core/server-constants";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  resolveOwnedTeam,
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
  inputSchema: z.object({
    /** The same selection the page is showing; they must share one team. */
    siteSlugs: z
      .array(z.string().min(1).max(60).refine(isValidSiteSlug))
      .min(1)
      .max(50),
  }),
  outputSchema: z.object({ url: z.string() }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    if (!org.slug) {
      throw new Error("Organization context required");
    }

    const slugs = [...new Set(input.siteSlugs.map((s) => s.toLowerCase()))];
    const ownedSlugs = (await ctx.storage.orgSites.listByOrg(org.id)).map(
      (site) => site.slug,
    );
    const owned = new Set(ownedSlugs);
    const unowned = slugs.filter((slug) => !owned.has(slug));
    if (unowned.length > 0) {
      throw new Error(
        `Site not found in organization: ${unowned.sort().join(", ")}`,
      );
    }

    // Portal sessions can cancel the team's subscription — require the whole team.
    const scope = await resolveOwnedTeam(slugs, ownedSlugs);
    if (!scope.ok) {
      throw new Error(
        scope.reason === "partial_team"
          ? "This site's legacy team also bills sites outside this organization. Manage the subscription from the deco.cx admin."
          : "This site has no Stripe subscription to manage.",
      );
    }

    const subscriptionId = await teamStripeSubscriptionId(scope.teamId);
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
      // Stripe's raw message names the subscription id — not the caller's to see.
      if (err instanceof StripeApiError) {
        console.error("[infra-billing] portal session failed:", err);
        throw new Error("Could not open the billing portal. Try again later.");
      }
      throw err;
    }
  },
});
