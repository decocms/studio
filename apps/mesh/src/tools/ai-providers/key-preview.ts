import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const AI_PROVIDER_KEY_PREVIEW = defineTool({
  name: "AI_PROVIDER_KEY_PREVIEW",
  description:
    "Get the label and a masked preview of a stored AI provider API key. The API key is partially obscured (only the last 4 characters are visible). For openai-compatible keys the baseUrl is also returned.",
  inputSchema: z.object({ keyId: z.string() }),
  outputSchema: z.object({
    label: z.string(),
    maskedKey: z.string(),
    baseUrl: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();
    return ctx.storage.aiProviderKeys.getPreview(input.keyId, org.id);
  },
});
