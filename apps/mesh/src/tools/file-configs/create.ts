import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  fileConfigInfoSchema,
  fileConfigNameSchema,
  normalizePrefix,
  normalizePublicUrlBase,
} from "./schema";

export const FILE_CONFIG_CREATE = defineTool({
  name: "FILE_CONFIG_CREATE",
  description:
    "Create an S3-compatible bucket configuration scoped to the organization. The access key and secret key are encrypted at rest in the credential vault and never returned by any tool.",
  inputSchema: z.object({
    name: fileConfigNameSchema,
    description: z.string().max(500).optional(),
    bucket: z.string().min(1).max(255),
    region: z.string().min(1).max(64),
    endpoint: z.string().url().optional(),
    forcePathStyle: z.boolean().optional(),
    prefix: z.string().max(512).optional(),
    publicUrlBase: z.string().url().optional(),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  }),
  outputSchema: fileConfigInfoSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    return ctx.storage.orgFileConfigs.create({
      organizationId: org.id,
      name: input.name,
      description: input.description ?? null,
      bucket: input.bucket,
      region: input.region,
      endpoint: input.endpoint ?? null,
      forcePathStyle: input.forcePathStyle ?? false,
      prefix: normalizePrefix(input.prefix),
      publicUrlBase: normalizePublicUrlBase(input.publicUrlBase),
      credentials: {
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
      },
      createdBy: ctx.auth.user!.id,
    });
  },
});
