import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const FILE_CONFIG_DELETE = defineTool({
  name: "FILE_CONFIG_DELETE",
  description: "Delete an S3 bucket configuration by id.",
  inputSchema: z.object({
    id: z.string().min(1),
  }),
  outputSchema: z.object({
    success: z.literal(true),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    await ctx.storage.orgFileConfigs.delete(input.id, org.id);
    return { success: true as const };
  },
});
