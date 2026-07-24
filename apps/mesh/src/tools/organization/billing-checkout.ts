/**
 * ORGANIZATION_BILLING_CHECKOUT_START / ORGANIZATION_SEATS_PREVIEW
 *
 * The self-serve money flow around seats:
 *  - CHECKOUT_START: first subscribe. The admin stages WHO is paid via
 *    ORGANIZATION_SEATS_SET (rows grant/unlock nothing while status != active),
 *    then this creates the Stripe Checkout session with quantity = the staged
 *    paid count. Completion comes back via the webhook (binds the
 *    subscription, flips status, delivers the allowance). The ONE redirect in
 *    the org's life — afterwards seat changes charge inline.
 *  - SEATS_PREVIEW: the apply bar's "you pay R$X now" — Stripe's prorated
 *    invoice preview for moving this cycle to the staged quantity.
 */

import { z } from "zod";
import {
  createSeatCheckoutSession,
  previewSeatChange,
  StripeApiError,
} from "../../billing/stripe-api";
import { getBaseUrl } from "../../core/server-constants";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";

export const ORGANIZATION_BILLING_CHECKOUT_START = defineTool({
  name: "ORGANIZATION_BILLING_CHECKOUT_START",
  description:
    "Start the organization's seat subscription: creates a Stripe Checkout session for the current paid-seat count and returns its URL.",
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
    quantity: z.number(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    const orgSlug = ctx.organization?.slug;
    if (!organizationId || !orgSlug) {
      throw new Error("Organization context required");
    }

    const [billing, paidSeatUserIds] = await Promise.all([
      ctx.storage.organizationBilling.getBilling(organizationId),
      ctx.storage.organizationBilling.listPaidSeatUserIds(organizationId),
    ]);
    if (!billing || billing.legacy) {
      throw new Error(
        "This organization is on the legacy plan — no subscription needed.",
      );
    }
    if (billing.billingMode !== "self_serve") {
      throw new Error("Contract-billed organizations do not use checkout.");
    }
    if (billing.status === "active") {
      throw new Error(
        "This organization already has an active subscription — seat changes apply directly.",
      );
    }
    const quantity = paidSeatUserIds.length;
    if (quantity < 1) {
      throw new Error(
        "Mark at least one member as a paid seat before subscribing.",
      );
    }

    const membersUrl = `${getBaseUrl()}/${encodeURIComponent(orgSlug)}/members`;
    try {
      const { url } = await createSeatCheckoutSession({
        organizationId,
        quantity,
        successUrl: `${membersUrl}?checkout=success`,
        cancelUrl: `${membersUrl}?checkout=canceled`,
      });
      return { url, quantity };
    } catch (err) {
      if (err instanceof StripeApiError) throw new Error(err.message);
      throw err;
    }
  },
});

export const ORGANIZATION_SEATS_PREVIEW = defineTool({
  name: "ORGANIZATION_SEATS_PREVIEW",
  description:
    "Preview what the organization pays now for changing its paid-seat count (Stripe prorated invoice preview). Read-only — nothing is charged.",
  annotations: {
    title: "Preview Seat Change",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    /** The resulting paid-seat count the staged changes would produce. */
    quantity: z.number().int().min(1).max(1000),
  }),
  outputSchema: z.object({
    /** Prorated amount charged on apply (negative = credited). */
    amountDueCents: z.number(),
    currency: z.string(),
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
    if (
      !billing ||
      billing.billingMode !== "self_serve" ||
      billing.status !== "active" ||
      !billing.stripeSubscriptionId
    ) {
      throw new Error("Seat previews need an active self-serve subscription.");
    }

    try {
      return await previewSeatChange({
        subscriptionId: billing.stripeSubscriptionId,
        quantity: input.quantity,
      });
    } catch (err) {
      if (err instanceof StripeApiError) throw new Error(err.message);
      throw err;
    }
  },
});
