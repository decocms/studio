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
  claimed: z
    .boolean()
    .describe(
      "False when the site isn't claimed/upgraded for this org — providers is then empty because the status is unreadable, NOT because nothing is connected. The UI must warn instead of rendering existing bindings as disconnected.",
    ),
  claim: z
    .object({ method: z.string().nullable(), verified: z.boolean() })
    .nullable()
    .describe(
      "How this org's claim on the domain was granted. verified=false ⇒ provisional: the org sees its report but should be nudged to verify (connecting GA4/GSC verifies automatically). Null when the org doesn't hold the diagnostic or the worker predates the field.",
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

    return fetchCommerceDiscoveryConnectionStatus({
      siteUrl: normalized.value,
      orgId: organization.id,
    });
  },
});
