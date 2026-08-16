/**
 * INFRA_BILLING_GET — one month of infra usage, plan and invoices for a legacy
 * deco.cx site the org owns. Ownership is checked against `org_sites`, so a
 * member of org A can never read org B's site by guessing its slug.
 */

import { z } from "zod";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { getSiteInfraBilling } from "../../deco-legacy/infra-billing";

export const INFRA_BILLING_GET = defineTool({
  name: "INFRA_BILLING_GET",
  description:
    "Get infra usage (requests, data transfer, pageviews), plan and invoices for one legacy deco.cx site owned by this organization, for a given month.",
  annotations: {
    title: "Get Infra Billing",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    /** Sites to aggregate. Every one must be owned by the calling org. */
    siteSlugs: z
      .array(z.string().min(1).max(60).refine(isValidSiteSlug))
      .min(1)
      .max(50),
    /** Any date inside the wanted month (ISO). Defaults to the current month. */
    period: z.string().optional(),
  }),
  outputSchema: z.object({
    siteSlugs: z.array(z.string()),
    since: z.string(),
    until: z.string(),
    usage: z.array(
      z.object({
        date: z.string(),
        requests: z.number(),
        dataTransferBytes: z.number(),
        pageviews: z.number(),
      }),
    ),
    /** False when no pageview source answered — render "—", never 0. */
    pageviewsAvailable: z.boolean(),
    /** True when this deployment has no analytics warehouse configured. */
    usageUnavailable: z.boolean(),
    /** Why `billing` is null, so the UI names the real cause. */
    billingUnavailableReason: z
      .enum(["no_team", "multiple_teams", "partial_team", "unavailable"])
      .nullable(),
    /** Plan and invoices belong to the legacy team, so they are only reported
     *  when the whole selection rolls up to exactly one team the org fully owns. */
    billing: z
      .object({
        planType: z.enum(["free", "pro", "enterprise"]),
        /** "YYYY-MM-DD", or null when nothing schedules a next charge. */
        nextBillingDate: z.string().nullable(),
        /** Whether INFRA_BILLING_PORTAL has a Stripe customer to open for. */
        canManageSubscription: z.boolean(),
        invoices: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            dueDate: z.string().nullable(),
            value: z.number(),
            referenceMonth: z.string().nullable(),
            nfUrl: z.string().nullable(),
            bankSlipUrl: z.string().nullable(),
          }),
        ),
      })
      .nullable(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);

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

    return getSiteInfraBilling({
      siteSlugs: slugs,
      ownedSlugs,
      period: input.period,
    });
  },
});
