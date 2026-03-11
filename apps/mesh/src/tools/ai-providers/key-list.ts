import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";

export const AI_PROVIDER_KEY_LIST = defineTool({
  name: "AI_PROVIDER_KEY_LIST",
  description:
    "List stored API keys for AI providers (metadata only, no secrets)",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS).optional(),
  }),
  outputSchema: z.object({
    keys: z.array(
      z.object({
        id: z.string(),
        providerId: z.string(),
        label: z.string(),
        createdBy: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const keys = await ctx.storage.aiProviderKeys.list({
      organizationId: org.id,
      providerId: input.providerId,
    });

    return { keys };
  },
});
