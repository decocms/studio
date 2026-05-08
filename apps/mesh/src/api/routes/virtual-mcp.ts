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
import { SpanStatusCode } from "@opentelemetry/api";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "@/core/constants";
import { createVirtualClientFrom } from "../../mcp-clients/virtual-mcp";
import type { Env } from "../hono-env";
import { guardResponseStream } from "../utils/stream-guard";

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

    const virtualMcp = await ctx.tracer.startActiveSpan(
      "mesh.virtual_mcp.lookup",
      { attributes: { "virtual_mcp.id": virtualId } },
      async (span) => {
        try {
          const result = await ctx.storage.virtualMcps.findById(
            virtualId,
            organizationId ?? undefined,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error).message,
          });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      },
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

    if (
      ctx.organization?.id &&
      virtualMcp.organization_id !== ctx.organization.id
    ) {
      return c.json(
        { error: "Forbidden: Agent does not belong to your organization" },
        403,
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
    const client = await ctx.tracer.startActiveSpan(
      "mesh.virtual_mcp.create_client",
      { attributes: { "virtual_mcp.id": virtualMcp.id ?? "decopilot" } },
      async (span) => {
        try {
          const result = await createVirtualClientFrom(
            virtualMcp,
            ctx,
            "passthrough",
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error).message,
          });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      },
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
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
    });

    // Create transport
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse:
        c.req.header("Accept")?.includes("application/json") ?? false,
    });

    // Connect server to transport
    await server.connect(transport);

    const response = await transport.handleRequest(c.req.raw);
    return guardResponseStream(
      response,
      `virtual-mcp:${virtualMcp.id ?? "decopilot"}`,
    );
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

export const createVirtualMcpRoutes = () => {
  const app = new Hono<Env>();

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

  return app;
};
