import {
  fromWire,
  legacyGithubRepo,
} from "@decocms/shared/reports/repository-ref";
import {
  getCommerceDiscoveryReportOwnerId,
  WellKnownOrgMCPId,
} from "@decocms/shared/sdk";
import { z } from "zod";
import { normalizeReportsSiteUrl } from "@decocms/shared/reports/site-url";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { triggerCommerceDiscoveryRun } from "./auth-client";
import { resolveCommerceReportOwnerId } from "./ownership";

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

    const cdConnectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(
      organization.id,
    );
    return ctx.storage.commerceDiscoveryReports.withSetupLock(
      organization.id,
      async ({ connections, virtualMcps, reports }) => {
        // Read the mutable connection and start the run under the same lock as
        // setup, so the run snapshot cannot straddle an owner/site transfer.
        const cdConnection = await connections.findById(
          cdConnectionId,
          organization.id,
        );
        const fallbackProjectId = getCommerceDiscoveryReportOwnerId(
          organization.id,
          undefined,
        );
        const reportOwnerProjectId = await resolveCommerceReportOwnerId(
          virtualMcps,
          getCommerceDiscoveryReportOwnerId(
            organization.id,
            cdConnection?.metadata?.projectId,
          ),
          organization.id,
          fallbackProjectId,
        );

        // Forward repository identity and the compatible GitHub spelling.
        const configState = cdConnection?.configuration_state as
          | Record<string, unknown>
          | string
          | null
          | undefined;
        const state =
          configState && typeof configState === "object" ? configState : null;
        const repository = fromWire(state?.repository);
        const legacy =
          typeof state?.github_repo === "string" && state.github_repo.length > 0
            ? state.github_repo
            : undefined;

        const result = await triggerCommerceDiscoveryRun({
          siteUrl: normalized.value,
          orgId: organization.id,
          repository: repository ?? undefined,
          githubRepo:
            (repository ? legacyGithubRepo(repository) : legacy) ?? undefined,
        });
        if (!result.triggered) return result;

        await reports.recordRun({
          organizationId: organization.id,
          runId: result.runId,
          siteUrl: normalized.value,
          virtualMcpId: reportOwnerProjectId,
        });
        return { triggered: true };
      },
    );
  },
});
