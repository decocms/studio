import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  deleteObject,
  resolveFileConfig,
} from "../../file-storage/file-config-s3";

export const FILE_OBJECT_DELETE = defineTool({
  name: "FILE_OBJECT_DELETE",
  description:
    "Delete a single object from a configured S3 bucket by its key. Used by the Assets browser to remove uploaded files. Idempotent: deleting a missing key succeeds.",
  annotations: {
    idempotentHint: true,
    destructiveHint: true,
  },
  inputSchema: z.object({
    configId: z.string().min(1),
    key: z.string().min(1),
  }),
  outputSchema: z.object({
    success: z.literal(true),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    // resolveFileConfig enforces managed-config ownership (the single choke point).
    const fileCfg = await resolveFileConfig(
      ctx.storage.orgFileConfigs,
      ctx.storage.orgSites,
      input.configId,
      org.id,
    );

    await deleteObject({ ctx: fileCfg, key: input.key });
    return { success: true as const };
  },
});
