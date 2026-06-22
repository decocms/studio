import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import type { FileConfigCredentials } from "../../storage/org-file-configs";
import {
  fileConfigInfoSchema,
  fileConfigNameSchema,
  normalizePrefix,
  normalizePublicUrlBase,
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
      publicUrlBase: z.string().url().nullable().optional(),
      // Rotate credentials by providing one complete set. Omit all to leave
      // credentials untouched. `static`: accessKeyId + secretAccessKey.
      // `sts-session`: refreshUrl + apiKey.
      accessKeyId: z.string().min(1).optional(),
      secretAccessKey: z.string().min(1).optional(),
      refreshUrl: z.string().url().optional(),
      apiKey: z.string().min(1).optional(),
    })
    .superRefine((v, c) => {
      const hasStatic =
        v.accessKeyId !== undefined || v.secretAccessKey !== undefined;
      const hasSts = v.refreshUrl !== undefined || v.apiKey !== undefined;
      if (hasStatic && hasSts) {
        c.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Provide either static (accessKeyId + secretAccessKey) or sts-session (refreshUrl + apiKey) credentials, not both.",
        });
      }
      if (hasStatic && !(v.accessKeyId && v.secretAccessKey)) {
        c.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "accessKeyId and secretAccessKey must be provided together when rotating static credentials.",
        });
      }
      if (hasSts && !(v.refreshUrl && v.apiKey)) {
        c.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "refreshUrl and apiKey must be provided together when rotating sts-session credentials.",
        });
      }
    }),
  outputSchema: fileConfigInfoSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    let credentials: FileConfigCredentials | undefined;
    let refreshUrl: string | null | undefined;
    if (input.accessKeyId && input.secretAccessKey) {
      credentials = {
        type: "static",
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
      };
      refreshUrl = null;
    } else if (input.refreshUrl && input.apiKey) {
      credentials = { type: "sts-session", apiKey: input.apiKey };
      refreshUrl = input.refreshUrl;
    }

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
      publicUrlBase:
        input.publicUrlBase === undefined
          ? undefined
          : normalizePublicUrlBase(input.publicUrlBase),
      refreshUrl,
      credentials,
      updatedBy: ctx.auth.user!.id,
    });
  },
});
