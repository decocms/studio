import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";

export const providerKeyOutputSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string(),
  createdAt: z.string(),
});

export const AI_PROVIDER_KEY_CREATE = defineTool({
  name: "AI_PROVIDER_KEY_CREATE",
  description:
    "Store an API key for an AI provider. The key is encrypted at rest in the vault.",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS),
    label: z.string().min(1).max(100),
    apiKey: z.string().min(1),
  }),
  outputSchema: providerKeyOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const key = await ctx.storage.aiProviderKeys.create({
      providerId: input.providerId,
      label: input.label,
      apiKey: input.apiKey,
      organizationId: org.id,
      createdBy: ctx.auth.user!.id,
    });

    return {
      id: key.id,
      providerId: key.providerId,
      label: key.label,
      createdAt: key.createdAt,
    };
  },
});
