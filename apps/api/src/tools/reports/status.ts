import { z } from "zod";
import { normalizeReportsSiteUrl } from "@decocms/shared/reports/site-url";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { fetchReportsConnectionStatus } from "./auth-client";

const ReportsStatusInputSchema = z.object({
  siteUrl: z.string().min(1).describe("Website URL of the store to inspect."),
});

const ReportsStatusOutputSchema = z.object({
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
});

export const REPORTS_CONNECTION_STATUS = defineTool({
  name: "REPORTS_CONNECTION_STATUS",
  description:
    "Read per-provider connection status (ga4/gsc/vtex) for the org's store — { connected, via: oauth|sa, resource }. The single source of truth for whether a data source is connected, unifying the OAuth (Studio vault) and shared-SA binding lanes. Read-only.",
  annotations: {
    title: "Deco Score Connection Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: ReportsStatusInputSchema,
  outputSchema: ReportsStatusOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    /**
     * Both names, because a tool name IS the permission resource: a stored
     * grant (an API key's allowlist, a custom role) that named the tool
     * before it was renamed would otherwise be silently revoked. `check`
     * grants on the first resource that passes.
     */
    await ctx.access.check(
      "REPORTS_CONNECTION_STATUS",
      "COMMERCE_DISCOVERY_CONNECTION_STATUS",
    );

    const normalized = normalizeReportsSiteUrl(input.siteUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }

    return fetchReportsConnectionStatus({
      siteUrl: normalized.value,
      orgId: organization.id,
    });
  },
});
