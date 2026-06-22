import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { tenantStorageDescriptor } from "../../file-storage/tenant-credentials";
import {
  fileConfigInfoSchema,
  fileConfigNameSchema,
  normalizePrefix,
  normalizePublicUrlBase,
} from "./schema";

export const FILE_CONFIG_CREATE = defineTool({
  name: "FILE_CONFIG_CREATE",
  description:
    "Create an S3-compatible bucket configuration scoped to the organization. `static` stores a long-lived key pair (BYOB). `sts-session` stores a refreshUrl + apiKey whose temporary credentials are fetched on demand and auto-refreshed. `managed` stores no secret — studio mints prefix-scoped credentials for a site slug the org owns on the shared tenant bucket (bucket/region/CDN derived server-side). Secrets are encrypted at rest and never returned by any tool.",
  inputSchema: z
    .object({
      name: fileConfigNameSchema,
      description: z.string().max(500).optional(),
      bucket: z.string().min(1).max(255).optional(),
      region: z.string().min(1).max(64).optional(),
      endpoint: z.string().url().optional(),
      forcePathStyle: z.boolean().optional(),
      prefix: z.string().max(512).optional(),
      publicUrlBase: z.string().url().optional(),
      credentialType: z
        .enum(["static", "sts-session", "managed"])
        .default("static"),
      // static
      accessKeyId: z.string().min(1).optional(),
      secretAccessKey: z.string().min(1).optional(),
      // sts-session
      refreshUrl: z.string().url().optional(),
      apiKey: z.string().min(1).optional(),
      // managed
      siteSlug: z.string().min(1).max(60).optional(),
    })
    .superRefine((v, c) => {
      if (v.credentialType === "managed") {
        if (!v.siteSlug) {
          c.addIssue({
            code: z.ZodIssueCode.custom,
            message: "managed credentials require siteSlug.",
          });
        }
        if (v.accessKeyId || v.secretAccessKey || v.refreshUrl || v.apiKey) {
          c.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "managed credentials take no accessKeyId/secretAccessKey/refreshUrl/apiKey.",
          });
        }
        return;
      }

      // static / sts-session both require an explicit bucket + region.
      if (!v.bucket || !v.region) {
        c.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bucket and region are required.",
        });
      }
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

    if (input.credentialType === "managed") {
      const slug = input.siteSlug!;
      if (!(await ctx.storage.orgSites.isOwnedBy(slug, org.id))) {
        throw new Error(
          `Organization does not own site "${slug}". A site is claimed via the deco import or the org-sites backfill.`,
        );
      }
      // All storage fields are server-derived from the managed tenant bucket.
      // Bucket/region/endpoint/prefix inputs are intentionally IGNORED for
      // managed configs: the STS session policy is hardcoded to
      // `<tenantBucket>/<slug>/*`, so allowing an override would let a config
      // point somewhere the minted credentials can't reach (AccessDenied) — the
      // config can never diverge from what the policy grants.
      const descriptor = tenantStorageDescriptor(slug);
      return ctx.storage.orgFileConfigs.create({
        organizationId: org.id,
        name: input.name,
        description: input.description ?? null,
        bucket: descriptor.bucket,
        region: descriptor.region,
        endpoint: descriptor.endpoint,
        forcePathStyle: descriptor.forcePathStyle,
        prefix: normalizePrefix(descriptor.prefix),
        publicUrlBase: normalizePublicUrlBase(descriptor.publicUrlBase),
        refreshUrl: null,
        siteSlug: slug,
        credentials: { type: "managed" },
        createdBy: ctx.auth.user!.id,
      });
    }

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
      bucket: input.bucket!,
      region: input.region!,
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
