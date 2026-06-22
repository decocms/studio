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
    "Create an S3-compatible bucket configuration scoped to the organization. Defaults to a `static` long-lived key pair (accessKeyId + secretAccessKey). Pass credentialType `sts-session` to instead store a refreshUrl + apiKey reference whose temporary credentials are fetched on demand and auto-refreshed. Secrets are encrypted at rest and never returned by any tool.",
  inputSchema: z
    .object({
      name: fileConfigNameSchema,
      description: z.string().max(500).optional(),
      bucket: z.string().min(1).max(255),
      region: z.string().min(1).max(64),
      endpoint: z.string().url().optional(),
      forcePathStyle: z.boolean().optional(),
      prefix: z.string().max(512).optional(),
      publicUrlBase: z.string().url().optional(),
      credentialType: z.enum(["static", "sts-session"]).default("static"),
      // static
      accessKeyId: z.string().min(1).optional(),
      secretAccessKey: z.string().min(1).optional(),
      // sts-session
      refreshUrl: z.string().url().optional(),
      apiKey: z.string().min(1).optional(),
    })
    .superRefine((v, c) => {
      if (v.credentialType === "sts-session") {
        if (!v.refreshUrl || !v.apiKey) {
          c.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "sts-session requires refreshUrl and apiKey (and no accessKeyId/secretAccessKey).",
          });
        }
      } else if (!v.accessKeyId || !v.secretAccessKey) {
        c.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "static credentials require accessKeyId and secretAccessKey.",
        });
      }
    }),
  outputSchema: fileConfigInfoSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const credentials =
      input.credentialType === "sts-session"
        ? { type: "sts-session" as const, apiKey: input.apiKey! }
        : {
            type: "static" as const,
            accessKeyId: input.accessKeyId!,
            secretAccessKey: input.secretAccessKey!,
          };

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
      refreshUrl: input.refreshUrl ?? null,
      credentials,
      createdBy: ctx.auth.user!.id,
    });
  },
});
