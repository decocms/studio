import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { z } from "zod";
import { normalizeReportsSiteUrl } from "@decocms/shared/reports/site-url";
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
    // Enforce the caller's role/permission for this tool (connections:manage),
    // like every other org-scoped tool — the internal API key gates the wire, not
    // who in the org may trigger a run.
    await ctx.access.check();

    const normalized = normalizeReportsSiteUrl(input.siteUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }

    // The repo the client picked in the GitHub companion is persisted on the CD
    // connection's configuration_state (github_repo). Forward it so Commerce
    // Discovery can run repo-audit against the right repo; its absence just means
    // GitHub isn't connected and never blocks the run.
    const cdConnectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(
      organization.id,
    );
    const cdConnection = await ctx.storage.connections.findById(
      cdConnectionId,
      organization.id,
    );
    const configState = cdConnection?.configuration_state as
      | Record<string, unknown>
      | string
      | null
      | undefined;
    const githubRepo =
      configState &&
      typeof configState === "object" &&
      typeof configState.github_repo === "string" &&
      configState.github_repo.length > 0
        ? (configState.github_repo as string)
        : undefined;

    return triggerCommerceDiscoveryRun({
      siteUrl: normalized.value,
      orgId: organization.id,
      githubRepo,
    });
  },
});
