/**
 * ORGANIZATION_BILLING_PORTAL / ORGANIZATION_INCLUDED_REPORT_SET
 *
 * The self-serve management surface around the subscription:
 *  - BILLING_PORTAL: Stripe's hosted Customer Portal (card, invoices,
 *    cancellation). We never build billing UI for what Stripe hosts; the
 *    session returns to the members page.
 *  - INCLUDED_REPORT_SET: pick which ONE site's weekly report re-run the
 *    subscription includes. The benefits sync propagates the choice to the
 *    reports service (schedule set/cleared) on its next delivery.
 */

import { z } from "zod";
import {
  createBillingPortalSession,
  StripeApiError,
} from "../../billing/stripe-api";
import {
  anyBenefitDeliverable,
  enqueueBenefitsSync,
} from "../../billing/sync-org-benefits";
import { getPublicUrl } from "../../core/server-constants";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { siteUrlToHost } from "@decocms/shared/reports/site-url";

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
    // Same gate as checkout: deco-managed billing (legacy/contract) must not
    // self-serve cancellation or card changes over a deco-owned customer.
    if (billing.legacy || billing.billingMode !== "self_serve") {
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

export const ORGANIZATION_INCLUDED_REPORT_SET = defineTool({
  name: "ORGANIZATION_INCLUDED_REPORT_SET",
  description:
    "Choose which site's weekly report re-run the organization's subscription includes (null clears it).",
  annotations: {
    title: "Set Included Report Site",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    /** Site host (e.g. "shop.example.com") or null to clear. */
    url: z.string().trim().min(1).max(255).nullable(),
  }),
  outputSchema: z.object({
    includedReportUrl: z.string().nullable(),
    /** Whether a durable benefit-sync delivery was queued (propagates the
     *  schedule change to the reports service). */
    benefitsSyncQueued: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);

    const billing = await ctx.storage.organizationBilling.getBilling(org.id);
    if (!billing || billing.legacy) {
      throw new Error(
        "This organization is on the legacy plan — included reports do not apply.",
      );
    }

    const normalized = input.url === null ? null : siteUrlToHost(input.url);
    if (input.url !== null && !normalized) {
      throw new Error(`"${input.url}" is not a valid site URL.`);
    }

    // The schedule change rides the benefits delivery (same machinery as the
    // allowance); the pending marker commits in the SAME update as the choice.
    const { updated, benefitsReferenceId } =
      await ctx.storage.organizationBilling.setIncludedReportUrl(
        org.id,
        normalized,
        { markBenefitsPending: anyBenefitDeliverable() },
      );
    if (!updated) {
      throw new Error("Organization billing row missing.");
    }

    let benefitsSyncQueued = false;
    if (benefitsReferenceId) {
      try {
        await enqueueBenefitsSync(org.id, benefitsReferenceId, "apply");
        benefitsSyncQueued = true;
      } catch (err) {
        console.error("Failed to enqueue benefit sync (sweep covers):", err);
      }
    }

    return { includedReportUrl: normalized, benefitsSyncQueued };
  },
});
