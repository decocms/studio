import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { fileConfigInfoSchema } from "./schema";

export const FILE_CONFIG_LIST = defineTool({
  name: "FILE_CONFIG_LIST",
  description:
    "List S3-compatible bucket configurations for the organization. Credentials are never returned.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    configs: z.array(fileConfigInfoSchema),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const configs = await ctx.storage.orgFileConfigs.list(org.id);
    return { configs };
  },
});
