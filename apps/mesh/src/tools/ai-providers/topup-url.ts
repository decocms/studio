import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { PROVIDERS } from "../../ai-providers/registry";

export const AI_PROVIDER_TOPUP_URL = defineTool({
  name: "AI_PROVIDER_TOPUP_URL",
  description:
    "Get a checkout URL to top up credits for a provider that supports it (e.g. Deco AI Gateway)",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS),
    keyId: z.string().describe("The ID of the stored provider key to top up"),
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

    const adapter = PROVIDERS[input.providerId];
    if (!adapter) {
      throw new Error(`Unknown provider: ${input.providerId}`);
    }
    if (!adapter.getTopUpUrl) {
      throw new Error(
        `Provider ${input.providerId} does not support credit top-ups`,
      );
    }

    const { apiKey } = await ctx.storage.aiProviderKeys.resolve(
      input.keyId,
      org.id,
    );

    const url = await adapter.getTopUpUrl(
      apiKey,
      input.amountCents,
      input.currency,
    );

    return { url };
  },
});
