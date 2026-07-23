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
import { getUserId, type StudioContext } from "../../core/studio-context";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "@/core/constants";
import { createVirtualClientFrom } from "../../mcp-clients/virtual-mcp";
import { resolveDevConnection } from "./dev-connection";
import type { ConnectionEntity } from "../../tools/connection/schema";
import type { Env } from "../hono-env";
import { serveMcpRequest } from "../utils/serve-mcp";

// ============================================================================
// Route Handler (shared between /gateway and /virtual-mcp endpoints for backward compat)
// ============================================================================

export async function handleVirtualMcpRequest(
  c: {
    get: (key: "studioContext") => StudioContext;
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
  const ctx = c.get("studioContext");

  try {
    // Prefer x-org-id header (no DB lookup) over x-org-slug (requires DB lookup).
    // External MCP clients (Claude Code/Desktop) send NEITHER — the org is in
    // the URL path (`/api/:org/mcp`), already resolved into `ctx.organization`
    // by the resolveOrgFromPath middleware. Fall back to it so the aggregate
    // (Decopilot) endpoint works without the internal UI's x-org-* headers;
    // otherwise organizationId stays null and the request 400s with
    // "Agent ID or organization ID is required".
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
        : (ctx.organization?.id ?? null);

    const virtualId = virtualMcpId
      ? virtualMcpId
      : organizationId
        ? getDecopilotId(organizationId)
        : null;

    if (!virtualId) {
      return c.json({ error: "Agent ID or organization ID is required" }, 400);
    }

    const virtualMcp = await ctx.tracer.startActiveSpan(
      "studio.virtual_mcp.lookup",
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

    // Surface the dev sandbox's tools when the acting user has a running sandbox
    // for this agent. The cheap local pre-filter is just "does the user have a
    // sandbox entry?" (no repo/pairing flag) — agents without a sandbox skip the
    // resolver entirely. resolveDevConnection then confirms the dev server
    // actually speaks MCP (probe). Safe on this legacy route's looser org
    // binding: it only resolves a sandbox the acting user themselves started.
    const actingUserId = getUserId(ctx);
    let devConnection: ConnectionEntity | null = null;
    if (virtualMcp.id && actingUserId) {
      devConnection = await resolveDevConnection(
        ctx,
        virtualMcp.id,
        actingUserId,
        c.req.query("branch") ?? undefined,
      ).catch(() => null);
    }

    // Create client from entity (always passthrough)
    const client = await ctx.tracer.startActiveSpan(
      "studio.virtual_mcp.create_client",
      { attributes: { "virtual_mcp.id": virtualMcp.id ?? "decopilot" } },
      async (span) => {
        try {
          const result = await createVirtualClientFrom(
            virtualMcp,
            ctx,
            "passthrough",
            false,
            // Serves the agent's MCP (incl. the desktop daemon); surface the
            // skill catalog in the instructions it reads.
            {
              includeSkillsCatalog: true,
              additionalConnections: devConnection ? [devConnection] : [],
            },
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
      // Use the client's instructions (not raw metadata) so attached
      // files/skills ride along to the sandbox daemon, which reads server
      // instructions over this endpoint to assemble its system prompt.
      instructions: client.getInstructions(),
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
    });

    // Create transport
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse:
        c.req.header("Accept")?.includes("application/json") ?? false,
    });

    // Connect server to transport
    await server.connect(transport);

    return await serveMcpRequest(
      server,
      transport,
      c.req.raw,
      `virtual-mcp:${virtualMcp.id ?? "decopilot"}`,
      // `client` is built fresh per request and is NOT pooled; the bridge
      // server delegates to it but never closes it. Close it here or the
      // PassthroughClient + every downstream lazy/real client + their
      // transports leak (GatewayClient.close() cascades to all children).
      { onClose: () => client.close() },
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
