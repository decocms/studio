import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  listObjects,
  resolveFileConfig,
} from "../../file-storage/file-config-s3";

export const FILE_OBJECTS_LIST = defineTool({
  name: "FILE_OBJECTS_LIST",
  description:
    "List existing objects in a configured S3 bucket (newest first). Returns public URLs computed from the config's publicUrlBase or the bucket's S3 host. Used by the picker dialog to let users select previously uploaded files.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  inputSchema: z.object({
    configId: z.string().min(1),
    cursor: z.string().nullable().optional(),
    maxKeys: z.number().int().min(1).max(200).optional(),
  }),
  outputSchema: z.object({
    items: z.array(
      z.object({
        key: z.string(),
        size: z.number(),
        lastModified: z.string().nullable(),
        publicUrl: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const fileCfg = await resolveFileConfig(
      ctx.storage.orgFileConfigs,
      input.configId,
      org.id,
    );

    return listObjects({
      ctx: fileCfg,
      cursor: input.cursor,
      maxKeys: input.maxKeys,
    });
  },
});
