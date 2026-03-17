import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { PROVIDERS } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";

export const AI_PROVIDER_CREDITS = defineTool({
  name: "AI_PROVIDER_CREDITS",
  description:
    "Get the current credit balance for a provider (providers that support it, e.g. Deco AI Gateway)",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS),
  }),
  outputSchema: z.object({
    balanceCents: z
      .number()
      .describe("Remaining balance in cents (e.g. 1000 = $10.00)"),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const adapter = PROVIDERS[input.providerId];
    if (!adapter) {
      throw new Error(`Unknown provider: ${input.providerId}`);
    }
    if (!adapter.getCreditsBalance) {
      throw new Error(
        `Provider ${input.providerId} does not expose a credits balance`,
      );
    }

    const meshJwt = await mintGatewayJwt(userId);

    return adapter.getCreditsBalance(meshJwt, org.id);
  },
});
