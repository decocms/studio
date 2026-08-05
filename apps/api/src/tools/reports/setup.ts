import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  type ConnectionEntity,
  getCommerceDiscoveryAgentId,
  getWellKnownCommerceDiscoveryConnection,
  getWellKnownCommerceDiscoveryVirtualMCP,
  type VirtualMCPEntity,
  WellKnownOrgMCPId,
} from "@decocms/shared/sdk";
import { z } from "zod";
import { normalizeReportsSiteUrl } from "@decocms/shared/reports/site-url";
import type { StudioContext } from "../../core/studio-context";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { ConnectionEntitySchema } from "../connection/schema";
import { VirtualMCPEntitySchema } from "../virtual/schema";
import {
  fetchCommerceDiscoveryAuth,
  resolveCommerceDiscoveryMcpUrl,
} from "./auth-client";

const REPORT_TOOL_NAME =
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME as "get_my_diagnostic";

/**
 * How recently an org must have been created for COMMERCE_DISCOVERY_SETUP to
 * treat it as "created by this onboarding flow" and default reports_only on.
 * Generous enough for a slow onboarding session; far below the age of any
 * established org.
 */
const FRESH_ORG_WINDOW_MS = 60 * 60 * 1000;

const CommerceDiscoverySetupInputSchema = z.object({
  siteUrl: z.string().min(1).describe("Website URL to configure."),
});

const CommerceDiscoverySetupOutputSchema = z.object({
  connection: ConnectionEntitySchema,
  virtualMcp: VirtualMCPEntitySchema,
  reportApp: z.object({
    connectionId: z.string(),
    virtualMcpId: z.string(),
    toolName: z.literal(REPORT_TOOL_NAME),
  }),
  created: z.object({
    connection: z.boolean(),
    virtualMcp: z.boolean(),
  }),
});

async function rereadConnectionOrThrow(
  ctx: StudioContext,
  connectionId: string,
  organizationId: string,
  error: unknown,
): Promise<ConnectionEntity> {
  const existing = await ctx.storage.connections.findById(
    connectionId,
    organizationId,
  );
  if (existing) return existing;
  throw error;
}

async function rereadVirtualMcpOrThrow(
  ctx: StudioContext,
  virtualMcpId: string,
  organizationId: string,
  error: unknown,
): Promise<VirtualMCPEntity> {
  const existing = await ctx.storage.virtualMcps.findById(
    virtualMcpId,
    organizationId,
  );
  if (existing) return existing;
  throw error;
}

export const COMMERCE_DISCOVERY_SETUP = defineTool({
  name: "COMMERCE_DISCOVERY_SETUP",
  description:
    "Create or return the Commerce Discovery connection and virtual MCP for the current organization.",
  annotations: {
    title: "Set Up Commerce Discovery",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: CommerceDiscoverySetupInputSchema,
  outputSchema: CommerceDiscoverySetupOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check("COLLECTION_CONNECTIONS_CREATE");

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to set up Commerce Discovery");
    }

    const normalized = normalizeReportsSiteUrl(input.siteUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }

    const connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(organization.id);
    const virtualMcpId = getCommerceDiscoveryAgentId(organization.id);

    // Claim contact forwarded on /upgrade: Commerce Discovery emails this
    // address when the run completes (the "generating" screen's promise). The
    // "diagnóstico completo" CTA must land on the report app view — NOT the
    // /commerce-onboarding page. Build the exact URL the onboarding "open report"
    // button navigates to (commerce-onboarding.tsx): /$org/$taskId with the vMCP
    // selected and its report view pinned open. connectionId + virtualMcpId are
    // deterministic per org, so the URL is fully known here at /upgrade time.
    //   main="app:<connectionId>:<toolName>" — pinned-view tab grammar
    //   (web/layouts/main-panel-tabs/tab-id.ts:formatPinnedViewTabId).
    //   No sidepanel param: the vMCP's chatDefaultOpen metadata selects Chat,
    //   matching the onboarding button.
    const reportSearch = new URLSearchParams({
      virtualmcpid: virtualMcpId,
      main: `app:${connectionId}:${REPORT_TOOL_NAME}`,
    });
    const claimContact = {
      email: ctx.auth.user?.email,
      reportUrl: `${ctx.baseUrl}/${encodeURIComponent(
        organization.slug ?? organization.id,
      )}/${crypto.randomUUID()}?${reportSearch.toString()}`,
    };

    let connection = await ctx.storage.connections.findById(
      connectionId,
      organization.id,
    );
    const created = {
      connection: false,
      virtualMcp: false,
    };

    // Claim the CURRENT site for this org, unconditionally, on every setup.
    //
    // The claim is Commerce Discovery's master-gated per-(org, site) upgrade —
    // POST /api/v2/internal/diagnostics/:domain/upgrade — which sets the
    // diagnostic to private, links the org, and mints a fresh report token.
    // But the studio-side connection is keyed per ORG
    // (WellKnownOrgMCPId.COMMERCE_DISCOVERY(organization.id)), not per site.
    //
    // Previously the /upgrade was only called when the connection was missing
    // (or missing its token). So selecting an EXISTING org whose connection
    // already had a token skipped /upgrade entirely for the new site: the site
    // was never claimed, and the subsequent /run returned 409 not_upgraded (no
    // private run ever started). Decouple the two lifecycles: always claim the
    // site here (upgrade is idempotent per (org, site)), then persist the
    // freshly-minted token + siteUrl onto the per-org connection so it follows
    // the site currently being onboarded and always holds the newest token.
    //
    // This also keeps us consistent with commerce-discovery#184, which revokes
    // prior report tokens for the URL on each /upgrade — because we persist the
    // token returned by THIS upgrade, the connection never holds a revoked one.
    const auth = await fetchCommerceDiscoveryAuth({
      siteUrl: normalized.value,
      orgId: organization.id,
      orgName: organization.name,
      ...claimContact,
    });

    // The MCP URL must target the same instance as the internal API — in
    // staging REPORTS_INTERNAL_API_URL (or the legacy CD env) overrides the host, so the
    // CD connection must point there too, not at the hardcoded prod constant.
    const mcpUrl = resolveCommerceDiscoveryMcpUrl();

    if (connection) {
      console.log("[commerce-discovery] syncing connection to claimed site", {
        orgId: organization.id,
        siteUrl: normalized.value,
        connectionId,
      });
      connection = await ctx.storage.connections.update(connection.id, {
        connection_url: mcpUrl,
        connection_token: auth.authorizationToken,
        metadata: { ...(connection.metadata ?? {}), siteUrl: normalized.value },
      });
    } else {
      console.log("[commerce-discovery] creating connection", {
        orgId: organization.id,
        siteUrl: normalized.value,
        connectionId,
      });

      try {
        const base = getWellKnownCommerceDiscoveryConnection(
          organization.id,
          auth.authorizationToken,
          mcpUrl,
        );
        connection = await ctx.storage.connections.create({
          ...base,
          // Persist the site so a returning session (arriving with no ?siteUrl
          // param) can still recover it and trigger the run from "See full report".
          metadata: { ...(base.metadata ?? {}), siteUrl: normalized.value },
          organization_id: organization.id,
          created_by: userId,
        });
        created.connection = true;
      } catch (error) {
        connection = await rereadConnectionOrThrow(
          ctx,
          connectionId,
          organization.id,
          error,
        );
      }
    }

    let virtualMcp = await ctx.storage.virtualMcps.findById(
      virtualMcpId,
      organization.id,
    );

    if (!virtualMcp) {
      console.log("[commerce-discovery] creating virtual MCP", {
        orgId: organization.id,
        siteUrl: normalized.value,
        connectionId: connection.id,
        virtualMcpId,
      });

      try {
        virtualMcp = await ctx.storage.virtualMcps.create(
          organization.id,
          userId,
          getWellKnownCommerceDiscoveryVirtualMCP(
            organization.id,
            connection.id,
          ),
          { id: virtualMcpId },
        );
        created.virtualMcp = true;
      } catch (error) {
        virtualMcp = await rereadVirtualMcpOrThrow(
          ctx,
          virtualMcpId,
          organization.id,
          error,
        );
      }
    }

    if (!virtualMcp.pinned) {
      virtualMcp = await ctx.storage.virtualMcps.update(virtualMcp.id, userId, {
        pinned: true,
      });
    }

    // Default the "reports only" flag on ONLY for orgs the onboarding flow
    // just created — an established org (already using other agents/MCPs)
    // doing its first commerce onboarding must NOT be collapsed to the
    // report surface. The org row's createdAt is the server-side signal
    // that the org was minted moments ago by the flow's ensure-organization
    // step; unlike a client-provided "isNewOrg" input it can't be spoofed,
    // and unlike a created.connection guard it survives setup retries.
    // Only set when never set (NULL), so an org that turns it off stays off.
    const orgRow = await ctx.db
      .selectFrom("organization")
      .select(["createdAt"])
      .where("id", "=", organization.id)
      .executeTakeFirst();
    const orgAgeMs = orgRow
      ? Date.now() - new Date(orgRow.createdAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (orgAgeMs < FRESH_ORG_WINDOW_MS) {
      const settings = await ctx.storage.organizationSettings.get(
        organization.id,
      );
      const flags = settings?.flags;
      const defaults: Record<string, boolean> = {};
      if (flags?.reports_only == null) {
        defaults.reports_only = true;
        // Reports-only orgs hide agent navigation, so the QA Agent / Code
        // Reviewer that would otherwise run from that UI must be on by
        // default for the reviewer flow (task-board PR review) to still
        // function. Only ride along with a fresh reports_only default, not
        // independently — an org that explicitly turned reports_only off
        // must not have these forced on.
        if (flags?.qa_agent_enabled == null) defaults.qa_agent_enabled = true;
        if (flags?.code_reviewer_enabled == null) {
          defaults.code_reviewer_enabled = true;
        }
      }
      if (Object.keys(defaults).length > 0) {
        await ctx.storage.organizationSettings.upsert(organization.id, {
          flags: defaults,
        });
      }
    }

    return {
      connection,
      virtualMcp,
      reportApp: {
        connectionId: connection.id,
        virtualMcpId: virtualMcp.id,
        toolName: REPORT_TOOL_NAME,
      },
      created,
    };
  },
});
