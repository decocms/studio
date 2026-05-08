import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { providerKeyOutputSchema } from "./key-create";

export const AI_PROVIDER_KEY_UPDATE = defineTool({
  name: "AI_PROVIDER_KEY_UPDATE",
  description: "Update the label of a stored AI provider API key.",
  inputSchema: z.object({
    keyId: z.string(),
    label: z.string().min(1).max(100),
  }),
  outputSchema: providerKeyOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const key = await ctx.storage.aiProviderKeys.updateLabel(
      input.keyId,
      org.id,
      input.label,
    );

    return {
      id: key.id,
      providerId: key.providerId,
      label: key.label,
      presetId: key.presetId,
      createdAt: key.createdAt,
    };
  },
});
