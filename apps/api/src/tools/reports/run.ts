import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { z } from "zod";
import {
  fromWire,
  legacyGithubRepo,
} from "@decocms/shared/reports/repository-ref";
import { normalizeReportsSiteUrl } from "@decocms/shared/reports/site-url";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { triggerReportsRun } from "./auth-client";

const CommerceDiscoveryRunInputSchema = z.object({
  siteUrl: z.string().min(1).describe("Website URL to run the diagnostic for."),
});

const CommerceDiscoveryRunOutputSchema = z.object({
  triggered: z.boolean(),
  reason: z.string().optional(),
});

export const REPORTS_RUN = defineTool({
  name: "REPORTS_RUN",
  description:
    "Trigger the Reports diagnostic run for the current organization's store. Call once the data sources (GA4/GSC/VTEX) are connected — this run resolves credentials and produces the enriched report.",
  annotations: {
    title: "Run Reports",
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
    /**
     * Both names, because a tool name IS the permission resource: a stored
     * grant (an API key's allowlist, a custom role) that named the tool
     * before it was renamed would otherwise be silently revoked. `check`
     * grants on the first resource that passes.
     */
    await ctx.access.check("REPORTS_RUN", "COMMERCE_DISCOVERY_RUN");

    const normalized = normalizeReportsSiteUrl(input.siteUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }

    /**
     * The repository the client picked is persisted on the CD connection's
     * `configuration_state`. Forward it so Reports audits the right
     * one; its absence just means no repository is linked and never blocks the
     * run.
     *
     * Both spellings go out for the deprecation window: `repository` is the
     * identity (any provider, any host, resolvable back to a credential), and
     * `github_repo` is the legacy string a Reports still on the old reader
     * needs — derived from the reference when it is a github.com one, and read
     * straight off the state for an org the backfill has not reached.
     */
    const cdConnectionId = WellKnownOrgMCPId.REPORTS(organization.id);
    const cdConnection = await ctx.storage.connections.findById(
      cdConnectionId,
      organization.id,
    );
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

    return triggerReportsRun({
      siteUrl: normalized.value,
      orgId: organization.id,
      repository: repository ?? undefined,
      githubRepo:
        (repository ? legacyGithubRepo(repository) : legacy) ?? undefined,
    });
  },
});
