import z from "zod";
import { gatewayAdminConfigured } from "../../billing/gateway-admin";
import { createTopUpCheckoutSession } from "../../billing/stripe-api";
import { defineTool } from "../../core/define-tool";
import { getPublicUrl } from "../../core/server-constants";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/studio-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { getProviders } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";
import { getSettings } from "../../settings";

export const AI_PROVIDER_TOPUP_URL = defineTool({
  name: "AI_PROVIDER_TOPUP_URL",
  description:
    "Get a checkout URL to top up credits for a provider that supports it (e.g. Deco AI Gateway)",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS),
    amountCents: z
      .number()
      .int()
      .positive()
      .describe("Amount in cents (e.g. 1000 = $10.00)"),
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

    // Single-Stripe migration (3.7): when this deployment owns billing
    // (Stripe secret + gateway admin — the credit MUST be deliverable) the
    // deco top-up goes through the MESH checkout: one Stripe customer, one
    // card, the webhook credits the gateway. USD only for now — BRL keeps
    // using the gateway's legacy checkout (its live FX conversion) until we
    // take on FX; the gateway Stripe module is deleted only after that.
    const settings = getSettings();
    if (
      input.providerId === "deco" &&
      input.currency === "usd" &&
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
        creditCents: input.amountCents,
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
