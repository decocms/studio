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

import { createServerFromClient } from "@decocms/mcp-utils";
import { getDecopilotId } from "@decocms/shared/sdk";
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
    // `ctx.organization` is the single source of truth for org context —
    // context-factory already resolves and MEMBERSHIP-VERIFIES x-org-id /
    // x-org-slug (and the path org, for the canonical /api/:org route) for
    // session- and OAuth-session-authenticated callers. Re-reading those
    // headers here independently would let an API key with no organization
    // in its own metadata (e.g. a webhook-trigger key scoped only to fire one
    // automation, see tools/automations/trigger-add.ts) name an arbitrary
    // x-org-id and reach any org's Virtual MCP — API keys are pre-scoped at
    // mint time and must never be widened by a caller-supplied header.
    const organizationId = ctx.organization?.id ?? null;

    const virtualId = virtualMcpId
      ? virtualMcpId
      : organizationId
        ? getDecopilotId(organizationId)
        : null;

    if (!virtualId) {
      return c.json({ error: "Agent ID or organization ID is required" }, 400);
    }

    // A specific virtual MCP id was requested but no organization context
    // could be resolved (legacy /mcp/gateway|virtual-mcp route hit without
    // x-org-id/x-org-slug headers and no path-resolved org — e.g. a
    // multi-org member whose session has no deterministic active org). The
    // ownership checks below only run when organizationId is truthy, so
    // without this guard the lookup falls through with no org scoping at
    // all and would serve whichever org happens to own that id.
    if (virtualMcpId && !organizationId) {
      return c.json({ error: "Organization context is required" }, 400);
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

    // ctx.organization is already resolved by context-factory and was just
    // verified above to match virtualMcp.organization_id — every path that
    // reaches this point has organizationId truthy (see the 400s above), so
    // re-fetching it here was a redundant DB round trip on every MCP
    // tool-call request, and it also silently dropped ctx.organization.role
    // (AuthTransport falls back to the session's active-org role when it's
    // missing, which can be a different org's role).

    // Surface tools from the hosted dev sandbox when it actually speaks MCP.
    // The resolver owns canonical/thread-scoped sandbox lookup.
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
            false,
            // Serves the agent's MCP, including native coding-agent terminals;
            // surface the skill catalog in the instructions they read.
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
