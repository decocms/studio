import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PROVIDERS } from "@/ai-providers/registry";

export const AI_PROVIDERS_LIST = defineTool({
  name: "AI_PROVIDERS_LIST",
  description:
    "List all available AI providers that can be connected with an API key",
  inputSchema: z.object({}),
  outputSchema: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        logo: z.string().optional(),
        supportedMethods: z.array(z.enum(["api-key", "oauth-pkce"])),
        supportsTopUp: z.boolean().optional(),
        supportsCredits: z.boolean().optional(),
      }),
    ),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const providers = Object.values(PROVIDERS)
      .filter((adapter) => !!adapter)
      .map((adapter) => ({
        ...adapter.info,
        supportedMethods: adapter.supportedMethods,
        supportsTopUp: !!adapter.getTopUpUrl,
        supportsCredits: !!adapter.getCreditsBalance,
      }));
    return { providers };
  },
});
