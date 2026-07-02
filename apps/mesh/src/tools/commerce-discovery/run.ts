import { z } from "zod";
import { normalizeCommerceSiteUrl } from "../../commerce-discovery/site-url";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { triggerCommerceDiscoveryRun } from "./auth-client";

const CommerceDiscoveryRunInputSchema = z.object({
  siteUrl: z.string().min(1).describe("Website URL to run the diagnostic for."),
});

const CommerceDiscoveryRunOutputSchema = z.object({
  triggered: z.boolean(),
  reason: z.string().optional(),
});

export const COMMERCE_DISCOVERY_RUN = defineTool({
  name: "COMMERCE_DISCOVERY_RUN",
  description:
    "Trigger the Commerce Discovery diagnostic run for the current organization's store. Call once the data sources (GA4/GSC/VTEX) are connected — this run resolves credentials and produces the enriched report.",
  annotations: {
    title: "Run Commerce Discovery",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: CommerceDiscoveryRunInputSchema,
  outputSchema: CommerceDiscoveryRunOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    const normalized = normalizeCommerceSiteUrl(input.siteUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }

    return triggerCommerceDiscoveryRun({
      siteUrl: normalized.value,
      orgId: organization.id,
    });
  },
});
