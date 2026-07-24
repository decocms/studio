import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { providerKeyOutputSchema } from "./key-create";

export const AI_PROVIDER_KEY_UPDATE = defineTool({
  name: "AI_PROVIDER_KEY_UPDATE",
  description:
    "Update the label and/or API key of a stored AI provider key. Pass apiKey to rotate the stored credential.",
  inputSchema: z.object({
    keyId: z.string(),
    label: z.string().min(1).max(100).optional(),
    apiKey: z.string().min(1).optional(),
  }),
  outputSchema: providerKeyOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const key = await ctx.storage.aiProviderKeys.updateKey(
      input.keyId,
      org.id,
      { label: input.label, apiKey: input.apiKey },
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
