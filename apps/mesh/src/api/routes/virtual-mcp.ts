/**
 * Virtual MCP / Agent Routes
 *
 * Provides endpoints for accessing Virtual MCPs (agents):
 * 1. /mcp/gateway/:virtualMcpId - Backward compatible endpoint
 * 2. /mcp/virtual-mcp/:virtualMcpId - New canonical endpoint
 *
 * Architecture:
 * - Lists connections for the Virtual MCP (from database or organization)
 * - Creates a ProxyCollection for all connections
 * - Uses lazy-loading aggregators (ToolAggregator, ResourceAggregator, etc.) to aggregate resources
 * - Deduplicates tools and prompts by name (first occurrence wins)
 * - Routes resources by URI (globally unique)
 * - Supports exclusion strategy for inverse tool selection
 */

import { createServerFromClient, getDecopilotId } from "@decocms/mesh-sdk";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import { createVirtualClientFrom } from "../../mcp-clients/virtual-mcp";
import type { Env } from "../hono-env";

// Define Hono variables type
const app = new Hono<Env>();

// ============================================================================
// Route Handler (shared between /gateway and /virtual-mcp endpoints for backward compat)
// ============================================================================

export async function handleVirtualMcpRequest(
  c: {
    get: (key: "meshContext") => MeshContext;
    req: {
      header: (name: string) => string | undefined;
      param: (name: string) => string | undefined;
      query: (name: string) => string | undefined;
      raw: Request;
    };
    json: (data: unknown, status?: number) => Response;
  },
  virtualMcpId: string | undefined,
) {
  const ctx = c.get("meshContext");

  try {
    // Prefer x-org-id header (no DB lookup) over x-org-slug (requires DB lookup)
    const orgId = c.req.header("x-org-id");
    const orgSlug = c.req.header("x-org-slug");

    const organizationId = orgId
      ? orgId
      : orgSlug
        ? await ctx.db
            .selectFrom("organization")
            .select("id")
            .where("slug", "=", orgSlug)
            .executeTakeFirst()
            .then((org) => org?.id)
        : null;

    const virtualId = virtualMcpId
      ? virtualMcpId
      : organizationId
        ? getDecopilotId(organizationId)
        : null;

    if (!virtualId) {
      return c.json({ error: "Agent ID or organization ID is required" }, 400);
    }

    const virtualMcp = await ctx.storage.virtualMcps.findById(
      virtualId,
      organizationId ?? undefined,
    );

    if (!virtualMcp) {
      return c.json({ error: "Agent not found" }, 404);
    }

    if (organizationId && virtualMcp.organization_id !== organizationId) {
      return c.json({ error: "Agent not found" }, 404);
    }

    if (virtualMcp.status !== "active") {
      return c.json(
        {
          error: `Agent is inactive: ${virtualMcp.id ?? "Decopilot"}`,
        },
        503,
      );
    }

    // Set connection context (Virtual MCPs are now connections)
    // Note: virtualMcp.id can be null for Decopilot agent, but connectionId should be set for routing
    ctx.connectionId = virtualMcp.id ?? undefined;

    // Set organization context
    const organization = await ctx.db
      .selectFrom("organization")
      .select(["id", "slug", "name"])
      .where("id", "=", virtualMcp.organization_id)
      .executeTakeFirst();

    if (organization) {
      ctx.organization = {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
      };
    }

    // Create client from entity (always passthrough)
    const client = await createVirtualClientFrom(
      virtualMcp,
      ctx,
      "passthrough",
    );

    // Build ImplementationSchema-compatible server info
    const serverInfo = {
      name: virtualMcp.id ?? "Decopilot",
      version: "1.0.0",
      title: virtualMcp.title ?? undefined,
      description: virtualMcp.description ?? undefined,
      icons: virtualMcp.icon ? [{ src: virtualMcp.icon }] : undefined,
    };

    // Create server from client using the bridge
    const server = createServerFromClient(client, serverInfo, {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        typeof virtualMcp.metadata?.instructions === "string"
          ? virtualMcp.metadata.instructions
          : undefined,
    });

    // Create transport
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse:
        c.req.header("Accept")?.includes("application/json") ?? false,
    });

    // Connect server to transport
    await server.connect(transport);

    return await transport.handleRequest(c.req.raw);
  } catch (error) {
    const err = error as Error;
    console.error("[virtual-mcp] Error handling virtual MCP request:", err);
    return c.json(
      { error: "Internal server error", message: err.message },
      500,
    );
  }
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Virtual MCP endpoint (backward compatible /mcp/gateway/:virtualMcpId)
 *
 * Route: POST /mcp/gateway/:virtualMcpId?
 * - If virtualMcpId is provided: use that specific Virtual MCP
 * - If virtualMcpId is omitted: use Decopilot agent (default agent)
 */
app.all("/gateway/:virtualMcpId?", async (c) => {
  const virtualMcpId =
    c.req.param("virtualMcpId") || c.req.header("x-virtual-mcp-id");
  return handleVirtualMcpRequest(c, virtualMcpId);
});

/**
 * Virtual MCP endpoint (new canonical /mcp/virtual-mcp/:virtualMcpId)
 *
 * Route: POST /mcp/virtual-mcp/:virtualMcpId?
 * - If virtualMcpId is provided: use that specific virtual MCP
 * - If virtualMcpId is omitted: use Decopilot agent (default agent)
 */
app.all("/virtual-mcp/:virtualMcpId?", async (c) => {
  const virtualMcpId =
    c.req.param("virtualMcpId") || c.req.header("x-virtual-mcp-id");
  return handleVirtualMcpRequest(c, virtualMcpId);
});

export default app;
