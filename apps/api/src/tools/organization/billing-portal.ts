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
  benefitsSyncEnabled,
  enqueueBenefitsSync,
} from "../../billing/sync-org-benefits";
import { getBaseUrl } from "../../core/server-constants";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";

/**
 * Normalize user input to the bare host the reports service keys diagnostics
 * by ("https://Shop.Example.com/x" → "shop.example.com"). null = invalid.
 */
export function normalizeSiteHost(raw: string): string | null {
  try {
    const candidate = raw.includes("://") ? raw : `https://${raw}`;
    const host = new URL(candidate).hostname.toLowerCase();
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

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
    const organizationId = ctx.organization?.id;
    const orgSlug = ctx.organization?.slug;
    if (!organizationId || !orgSlug) {
      throw new Error("Organization context required");
    }

    const billing =
      await ctx.storage.organizationBilling.getBilling(organizationId);
    if (!billing?.stripeCustomerId) {
      throw new Error(
        "This organization has no billing account yet — subscribe first.",
      );
    }

    try {
      return await createBillingPortalSession({
        customerId: billing.stripeCustomerId,
        returnUrl: `${getBaseUrl()}/${encodeURIComponent(orgSlug)}/members`,
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
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error("Organization context required");
    }

    const billing =
      await ctx.storage.organizationBilling.getBilling(organizationId);
    if (!billing || billing.legacy) {
      throw new Error(
        "This organization is on the legacy plan — included reports do not apply.",
      );
    }

    const normalized = input.url === null ? null : normalizeSiteHost(input.url);
    if (input.url !== null && !normalized) {
      throw new Error(`"${input.url}" is not a valid site URL.`);
    }

    // The schedule change rides the benefits delivery (same machinery as the
    // allowance); the pending marker commits in the SAME update as the choice.
    const { updated, benefitsReferenceId } =
      await ctx.storage.organizationBilling.setIncludedReportUrl(
        organizationId,
        normalized,
        { markBenefitsPending: benefitsSyncEnabled() },
      );
    if (!updated) {
      throw new Error("Organization billing row missing.");
    }

    let benefitsSyncQueued = false;
    if (benefitsReferenceId) {
      try {
        await enqueueBenefitsSync(organizationId, benefitsReferenceId, "apply");
        benefitsSyncQueued = true;
      } catch (err) {
        console.error("Failed to enqueue benefit sync (sweep covers):", err);
      }
    }

    return { includedReportUrl: normalized, benefitsSyncQueued };
  },
});
