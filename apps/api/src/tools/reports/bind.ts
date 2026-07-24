import { z } from "zod";
import { normalizeReportsSiteUrl } from "@decocms/shared/reports/site-url";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { bindCommerceDiscoveryResource } from "./auth-client";

const CommerceDiscoveryBindInputSchema = z.object({
  siteUrl: z.string().min(1).describe("Website URL of the store being bound."),
  provider: z
    .enum(["ga4", "gsc"])
    .describe(
      "Which Google source to bind: ga4 (Analytics) or gsc (Search Console).",
    ),
  resourceId: z
    .string()
    .min(1)
    .describe(
      "The resource id the client typed: GA4 numeric property id, or GSC site (sc-domain:example.com or https://example.com/).",
    ),
});

const CommerceDiscoveryBindOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    resourceId: z.string(),
    evidence: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string(),
    detail: z.string(),
  }),
]);

export const COMMERCE_DISCOVERY_BIND = defineTool({
  name: "COMMERCE_DISCOVERY_BIND",
  description:
    "Bind a GA4 property or GSC site to the org's store via the shared service account (consent-free lane). The client grants deco-reader@… access to the resource and provides its id; Commerce Discovery verifies the resource belongs to this domain before persisting. Returns ok:false with an actionable pt-BR detail when verification fails or the resource is already bound elsewhere.",
  annotations: {
    title: "Bind Commerce Discovery Data Source",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: CommerceDiscoveryBindInputSchema,
  outputSchema: CommerceDiscoveryBindOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    // Same gate as COMMERCE_DISCOVERY_RUN: the internal API key authorizes the
    // wire; ctx.access.check enforces which member of the org may bind.
    await ctx.access.check();

    const normalized = normalizeReportsSiteUrl(input.siteUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }

    return bindCommerceDiscoveryResource({
      siteUrl: normalized.value,
      orgId: organization.id,
      provider: input.provider,
      resourceId: input.resourceId.trim(),
    });
  },
});
