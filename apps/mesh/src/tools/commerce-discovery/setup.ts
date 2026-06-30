import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  type ConnectionEntity,
  getCommerceDiscoveryAgentId,
  getWellKnownCommerceDiscoveryConnection,
  getWellKnownCommerceDiscoveryVirtualMCP,
  type VirtualMCPEntity,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { z } from "zod";
import { normalizeCommerceSiteUrl } from "../../commerce-discovery/site-url";
import type { StudioContext } from "../../core/studio-context";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { ConnectionEntitySchema } from "../connection/schema";
import { VirtualMCPEntitySchema } from "../virtual/schema";
import { fetchCommerceDiscoveryAuth } from "./auth-client";

const REPORT_TOOL_NAME =
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME as "DISPLAY_REPORT";

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

function isMissingToken(connection: ConnectionEntity): boolean {
  return !connection.connection_token;
}

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

    const normalized = normalizeCommerceSiteUrl(input.siteUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }

    const connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(organization.id);
    const virtualMcpId = getCommerceDiscoveryAgentId(organization.id);

    let connection = await ctx.storage.connections.findById(
      connectionId,
      organization.id,
    );
    const created = {
      connection: false,
      virtualMcp: false,
    };

    if (connection && isMissingToken(connection)) {
      const auth = await fetchCommerceDiscoveryAuth({
        siteUrl: normalized.value,
        orgId: organization.id,
        orgName: organization.name,
      });
      if (auth.authorizationToken) {
        console.log("[commerce-discovery] repairing missing auth token", {
          orgId: organization.id,
          siteUrl: normalized.value,
          connectionId,
        });
        connection = await ctx.storage.connections.update(connection.id, {
          connection_token: auth.authorizationToken,
        });
      }
    }

    if (!connection) {
      const auth = await fetchCommerceDiscoveryAuth({
        siteUrl: normalized.value,
        orgId: organization.id,
        orgName: organization.name,
      });

      console.log("[commerce-discovery] creating connection", {
        orgId: organization.id,
        siteUrl: normalized.value,
        connectionId,
      });

      try {
        connection = await ctx.storage.connections.create({
          ...getWellKnownCommerceDiscoveryConnection(
            organization.id,
            auth.authorizationToken,
          ),
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
