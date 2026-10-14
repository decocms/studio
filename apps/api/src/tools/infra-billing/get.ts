/**
 * INFRA_BILLING_GET — one month of infra usage, plan and invoices for legacy
 * deco.cx sites the org owns. Ownership is checked against `org_sites`, so a
 * member of org A can never read org B's site by guessing its slug.
 */

import { z } from "zod";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { getSiteInfraBilling } from "../../deco-legacy/infra-billing";
import { resolveOwnedSlugs } from "./ownership";

export const INFRA_BILLING_GET = defineTool({
  name: "INFRA_BILLING_GET",
  description:
    "Get infra usage (requests, data transfer, pageviews) for legacy deco.cx sites owned by this organization for a given month, plus the plan and invoices of each legacy team behind them.",
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
    /** Plan and invoices are team-scoped, so they are reported per team. */
    teams: z.array(
      z.object({
        siteSlugs: z.array(z.string()),
        /** Null when withheld or unreadable — see `unavailableReason`. */
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
        unavailableReason: z.enum(["partial_team", "unavailable"]).nullable(),
      }),
    ),
    /** Selected sites no legacy team bills. */
    siteSlugsWithoutTeam: z.array(z.string()),
    /** True when the legacy team lookup is unconfigured or failed. */
    billingUnavailable: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);

    const { slugs, ownedSlugs } = await resolveOwnedSlugs(
      ctx,
      org.id,
      input.siteSlugs,
    );

    return getSiteInfraBilling({
      siteSlugs: slugs,
      ownedSlugs,
      period: input.period,
    });
  },
});
