import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/studio-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { getProviders } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";

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

    const adapter = getProviders()[input.providerId];
    if (!adapter) {
      throw new Error(`Unknown provider: ${input.providerId}`);
    }
    if (!adapter.getTopUpUrl) {
      throw new Error(
        `Provider ${input.providerId} does not support credit top-ups`,
      );
    }

    const meshJwt = await mintGatewayJwt(userId);

    const url = await adapter.getTopUpUrl(
      meshJwt,
      org.id,
      input.amountCents,
      input.currency,
    );

    return { url };
  },
});
