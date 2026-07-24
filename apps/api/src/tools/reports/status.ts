import { z } from "zod";
import { normalizeReportsSiteUrl } from "@decocms/shared/reports/site-url";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { fetchCommerceDiscoveryConnectionStatus } from "./auth-client";

const CommerceDiscoveryStatusInputSchema = z.object({
  siteUrl: z.string().min(1).describe("Website URL of the store to inspect."),
});

const CommerceDiscoveryStatusOutputSchema = z.object({
  providers: z.record(
    z.string(),
    z.object({
      connected: z.boolean(),
      via: z.enum(["oauth", "sa"]).nullable(),
      resource: z.string().nullable(),
    }),
  ),
});

export const COMMERCE_DISCOVERY_CONNECTION_STATUS = defineTool({
  name: "COMMERCE_DISCOVERY_CONNECTION_STATUS",
  description:
    "Read per-provider connection status (ga4/gsc/vtex) for the org's store — { connected, via: oauth|sa, resource }. The single source of truth for whether a data source is connected, unifying the OAuth (Studio vault) and shared-SA binding lanes. Read-only.",
  annotations: {
    title: "Commerce Discovery Connection Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: CommerceDiscoveryStatusInputSchema,
  outputSchema: CommerceDiscoveryStatusOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const normalized = normalizeReportsSiteUrl(input.siteUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }

    const providers = await fetchCommerceDiscoveryConnectionStatus({
      siteUrl: normalized.value,
      orgId: organization.id,
    });
    return { providers };
  },
});
