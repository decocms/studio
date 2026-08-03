import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/studio-context";
import { HOSTED_PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { getProviders } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";

// Ceiling per top-up — unbounded amounts overflow provider unit-amount
// limits downstream (opaque 500 instead of clean validation).
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
