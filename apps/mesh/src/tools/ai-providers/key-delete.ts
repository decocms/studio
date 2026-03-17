import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const AI_PROVIDER_KEY_DELETE = defineTool({
  name: "AI_PROVIDER_KEY_DELETE",
  description: "Delete a stored AI provider API key. Cannot be undone.",
  inputSchema: z.object({
    keyId: z.string().describe("The provider key ID to delete"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    await ctx.storage.aiProviderKeys.delete(input.keyId, org.id);

    return { success: true };
  },
});
