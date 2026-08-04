import z from "zod";
import { gatewayAdminConfigured } from "../../billing/gateway-admin";
import { createTopUpCheckoutSession } from "../../billing/stripe-api";
import { getPublicUrl } from "../../core/server-constants";
import { getSettings } from "../../settings";
import { defineTool } from "../../core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/studio-context";
import { HOSTED_PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { getProviders } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";

// Ceiling per top-up — Stripe's unit_amount cap is ~$1M and the fee
// multiplies further; unbounded amounts surface as an opaque 500.
const MAX_TOPUP_AMOUNT_CENTS = 1_000_000; // $10,000.00

export const AI_PROVIDER_TOPUP_URL = defineTool({
  name: "AI_PROVIDER_TOPUP_URL",
  description:
    "Get a checkout URL to top up credits for a provider that supports it (e.g. Deco AI Gateway)",
  inputSchema: z.object({
    providerId: z.enum(HOSTED_PROVIDER_IDS),
    amountCents: z
      .number()
      .int()
      .positive()
      .max(MAX_TOPUP_AMOUNT_CENTS)
      .describe("Amount in cents (e.g. 1000 = $10.00), max $10,000.00"),
    currency: z.enum(["usd", "brl"]).default("usd"),
  }),
  outputSchema: z.object({
    url: z
      .string()
      .describe("Checkout URL — open in browser to complete payment"),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    // Single-Stripe: when this deployment owns billing (Stripe secret +
    // gateway admin — the credit MUST be deliverable) the deco top-up goes
    // through the MESH checkout: one Stripe customer, one card, the webhook
    // credits the gateway. BRL is charged in centavos and credited as its
    // USD equivalent (rate locked at session creation — exchange-rate.ts).
    // The adapter fallback below dies with the gateway's Stripe module.
    const settings = getSettings();
    if (
      input.providerId === "deco" &&
      settings.stripeSecretKey &&
      gatewayAdminConfigured() &&
      org.slug
    ) {
      const billing = await ctx.storage.organizationBilling.getBilling(org.id);
      // getPublicUrl: the browser follows these from Stripe's domain, so they
      // must be externally reachable, never a localhost fallback.
      const settingsUrl = `${getPublicUrl()}/${encodeURIComponent(org.slug)}/settings`;
      const { url } = await createTopUpCheckoutSession({
        organizationId: org.id,
        amountCents: input.amountCents,
        currency: input.currency,
        feePercent: settings.topupFeePercent,
        customerId: billing?.stripeCustomerId ?? null,
        successUrl: `${settingsUrl}?topup=success`,
        cancelUrl: `${settingsUrl}?topup=canceled`,
      });
      return { url };
    }

    const adapter = getProviders()[input.providerId];
    if (!adapter) {
      throw new Error(`Unknown provider: ${input.providerId}`);
    }
    if (!adapter.getTopUpUrl) {
      throw new Error(
        `Provider ${input.providerId} does not support credit top-ups`,
      );
    }

    const studioJwt = await mintGatewayJwt(userId, ctx.auth.user?.email);

    const url = await adapter.getTopUpUrl(
      studioJwt,
      org.id,
      input.amountCents,
      input.currency,
    );

    return { url };
  },
});
