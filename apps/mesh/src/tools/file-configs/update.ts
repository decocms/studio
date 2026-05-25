import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  fileConfigInfoSchema,
  fileConfigNameSchema,
  normalizePrefix,
} from "./schema";

export const FILE_CONFIG_UPDATE = defineTool({
  name: "FILE_CONFIG_UPDATE",
  description:
    "Update an S3 bucket configuration. Credentials can be rotated by providing both accessKeyId and secretAccessKey; omit them to leave existing credentials untouched.",
  inputSchema: z
    .object({
      id: z.string().min(1),
      name: fileConfigNameSchema.optional(),
      description: z.string().max(500).nullable().optional(),
      bucket: z.string().min(1).max(255).optional(),
      region: z.string().min(1).max(64).optional(),
      endpoint: z.string().url().nullable().optional(),
      forcePathStyle: z.boolean().optional(),
      prefix: z.string().max(512).nullable().optional(),
      accessKeyId: z.string().min(1).optional(),
      secretAccessKey: z.string().min(1).optional(),
    })
    .refine(
      (v) =>
        (v.accessKeyId === undefined) === (v.secretAccessKey === undefined),
      {
        message:
          "accessKeyId and secretAccessKey must be provided together when rotating credentials.",
      },
    ),
  outputSchema: fileConfigInfoSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const credentials =
      input.accessKeyId && input.secretAccessKey
        ? {
            accessKeyId: input.accessKeyId,
            secretAccessKey: input.secretAccessKey,
          }
        : undefined;

    return ctx.storage.orgFileConfigs.update({
      id: input.id,
      organizationId: org.id,
      name: input.name,
      description: input.description,
      bucket: input.bucket,
      region: input.region,
      endpoint: input.endpoint,
      forcePathStyle: input.forcePathStyle,
      prefix:
        input.prefix === undefined ? undefined : normalizePrefix(input.prefix),
      credentials,
      updatedBy: ctx.auth.user!.id,
    });
  },
});
