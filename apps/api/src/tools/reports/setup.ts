import {
  agentAppPath,
  projectReportsPath,
} from "@decocms/shared/organization-paths";
import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  type ConnectionEntity,
  getCommerceDiscoveryAgentId,
  getCommerceDiscoveryReportOwnerId,
  getWellKnownCommerceDiscoveryConnection,
  getWellKnownReportVirtualMCP,
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
import {
  isValidCommerceReportOwner,
  resolveCommerceReportOwnerId,
} from "./ownership";

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
  projectId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Project that owns this report. Defaults to the Commerce Discovery report project.",
    ),
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
  if (isValidCommerceReportOwner(existing, virtualMcpId, organizationId)) {
    return existing;
  }
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
    const created = {
      connection: false,
      virtualMcp: false,
    };

    const setup = await ctx.storage.commerceDiscoveryReports.withSetupLock(
      organization.id,
      async ({ connections, virtualMcps, reports }) => {
        let connection = await connections.findById(
          connectionId,
          organization.id,
        );
        const fallbackProjectId = getCommerceDiscoveryReportOwnerId(
          organization.id,
          undefined,
        );
        const persistedProjectId = getCommerceDiscoveryReportOwnerId(
          organization.id,
          connection?.metadata?.projectId,
        );
        // Omitting projectId is the public-onboarding path. It may initialize a
        // new report to the well-known project, but it must not transfer an
        // existing explicitly-owned report back to that fallback.
        const selectedProjectId = input.projectId ?? persistedProjectId;
        const reportOwnerProjectId = await resolveCommerceReportOwnerId(
          virtualMcps,
          selectedProjectId,
          organization.id,
          fallbackProjectId,
        );

        // Commerce Discovery emails this URL when generation finishes. Public
        // onboarding keeps its established report-app destination; an explicit
        // project setup returns to that project's Reports route.
        const reportPath =
          input.projectId !== undefined
            ? projectReportsPath(
                organization.slug ?? organization.id,
                reportOwnerProjectId,
              )
            : agentAppPath(organization.slug ?? organization.id, {
                agentId: virtualMcpId,
                connectionId,
                toolName: REPORT_TOOL_NAME,
              });

        // Clear the old credential before asking the upstream claim endpoint
        // to revoke it. If the request succeeds but this process dies before
        // the final write, Studio has no persisted credential rather than a
        // credential Commerce Discovery has already revoked.
        if (connection?.connection_token) {
          connection = await connections.update(connection.id, {
            connection_token: null,
          });
        }

        const auth = await fetchCommerceDiscoveryAuth({
          siteUrl: normalized.value,
          orgId: organization.id,
          orgName: organization.name,
          email: ctx.auth.user?.email,
          reportUrl: `${ctx.baseUrl}${reportPath}`,
        });
        // Publish immutable attribution before the mutable connection tuple.
        // If the subsequent connection write fails, the already-started run
        // can still import into the project that originated it.
        await reports.recordRun({
          organizationId: organization.id,
          runId: auth.runId,
          siteUrl: normalized.value,
          virtualMcpId: reportOwnerProjectId,
        });
        const mcpUrl = resolveCommerceDiscoveryMcpUrl();
        const syncClaimedConnection = (current: ConnectionEntity) =>
          connections.update(current.id, {
            connection_url: mcpUrl,
            connection_token: auth.authorizationToken,
            metadata: {
              ...(current.metadata ?? {}),
              siteUrl: normalized.value,
              projectId: reportOwnerProjectId,
            },
          });

        if (connection) {
          console.log(
            "[commerce-discovery] syncing connection to claimed site",
            {
              orgId: organization.id,
              siteUrl: normalized.value,
              connectionId,
            },
          );
          connection = await syncClaimedConnection(connection);
        } else {
          console.log("[commerce-discovery] creating connection", {
            orgId: organization.id,
            siteUrl: normalized.value,
            connectionId,
          });
          const base = getWellKnownCommerceDiscoveryConnection(
            organization.id,
            auth.authorizationToken,
            mcpUrl,
          );
          connection = await connections.create({
            ...base,
            metadata: {
              ...(base.metadata ?? {}),
              siteUrl: normalized.value,
              projectId: reportOwnerProjectId,
            },
            organization_id: organization.id,
            created_by: userId,
          });
          created.connection = true;
        }

        return connection;
      },
    );
    let connection = setup;

    let virtualMcp = await ctx.storage.virtualMcps.findById(
      virtualMcpId,
      organization.id,
    );

    if (
      virtualMcp &&
      !isValidCommerceReportOwner(virtualMcp, virtualMcpId, organization.id)
    ) {
      throw new Error("Report project not found in organization");
    }

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
          getWellKnownReportVirtualMCP(organization.id, connection.id),
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
      // Reviewers are default-on org-wide (DEFAULT_ON_FLAGS); no forcing here.
      if (flags?.reports_only == null) {
        defaults.reports_only = true;
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
