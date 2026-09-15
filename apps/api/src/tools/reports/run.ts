import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { z } from "zod";
import {
  fromWire,
  legacyGithubRepo,
} from "@decocms/shared/reports/repository-ref";
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

    /**
     * The repository the client picked is persisted on the CD connection's
     * `configuration_state`. Forward it so Commerce Discovery audits the right
     * one; its absence just means no repository is linked and never blocks the
     * run.
     *
     * Both spellings go out for the deprecation window: `repository` is the
     * identity (any provider, any host, resolvable back to a credential), and
     * `github_repo` is the legacy string a Reports still on the old reader
     * needs — derived from the reference when it is a github.com one, and read
     * straight off the state for an org the backfill has not reached.
     */
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
    const state =
      configState && typeof configState === "object" ? configState : null;
    const repository = fromWire(state?.repository);
    const legacy =
      typeof state?.github_repo === "string" && state.github_repo.length > 0
        ? state.github_repo
        : undefined;

    return triggerCommerceDiscoveryRun({
      siteUrl: normalized.value,
      orgId: organization.id,
      repository: repository ?? undefined,
      githubRepo:
        (repository ? legacyGithubRepo(repository) : legacy) ?? undefined,
    });
  },
});
