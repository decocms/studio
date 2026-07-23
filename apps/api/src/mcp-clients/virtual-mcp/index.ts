/**
 * Virtual MCP Client
 *
 * Factory functions for creating MCP clients from Virtual MCP entities.
 * Shared between Virtual MCP routes and proxy routes for VIRTUAL connections.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isDecopilot } from "@decocms/shared/sdk";
import { SpanStatusCode } from "@opentelemetry/api";
import { getMcpListCache } from "../mcp-list-cache";
import type { StudioContext } from "../../core/studio-context";
import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import { isOrgSharedConnection } from "@decocms/shared/github-repo-scope";
import { PassthroughClient } from "./passthrough-client";
import { renderSkillsCatalogBlock } from "./skills-instructions";
import type { VirtualClientOptions } from "./types";

/**
 * Check if a connection would cause a self-reference for a Virtual MCP
 * (i.e., a VIRTUAL connection that references the same Virtual MCP)
 */
function isSelfReferencingVirtual(
  connection: ConnectionEntity,
  virtualMcpId: string | null,
): boolean {
  if (connection.connection_type !== "VIRTUAL") return false;
  if (!virtualMcpId || isDecopilot(virtualMcpId)) return false; // Decopilot agent can't self-reference
  return connection.id === virtualMcpId;
}

/**
 * Create a virtual MCP client from a connection entity
 *
 * @param connection - Connection entity with VIRTUAL type
 * @param ctx - Studio context for creating proxies
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Client instance with aggregated tools, resources, and prompts
 */
export async function createVirtualClient(
  connection: ConnectionEntity,
  ctx: StudioContext,
  superUser = false,
): Promise<Client> {
  // Virtual MCP ID is the connection ID
  const virtualMcpId = connection.id;

  // Load virtual MCP entity
  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp) {
    throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
  }

  // Create client from virtual MCP entity
  return createVirtualClientFrom(virtualMcp, ctx, "passthrough", superUser);
}

/**
 * Load virtual MCP entity and create passthrough MCP client
 * Uses inclusion mode: only connections specified in virtualMcp.connections are included
 *
 * @param virtualMcp - Virtual MCP entity from database
 * @param ctx - Studio context for creating proxies
 * @param _strategy - Kept for backward compatibility, always uses passthrough
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Client instance with aggregated tools, resources, and prompts
 */
export async function createVirtualClientFrom(
  virtualMcp: VirtualMCPEntity,
  ctx: StudioContext,
  _strategy: "passthrough",
  superUser = false,
  options?: {
    listTimeoutMs?: number;
    includeSkillsCatalog?: boolean;
    /**
     * Pre-resolved connections to prepend to the aggregated set — e.g. the
     * ephemeral per-user dev-server connection (`dev_<id>`). Prepended so they
     * shadow same-named virtual-mcp tools (the aggregator dedups first-wins).
     */
    additionalConnections?: ConnectionEntity[];
  },
): Promise<PassthroughClient> {
  // Inclusion mode: use only the connections specified in virtual MCP
  const connectionIds = virtualMcp.connections.map((c) => c.connection_id);

  // Load all connections in parallel
  const allConnections = await ctx.tracer.startActiveSpan(
    "studio.virtual_mcp.load_connections",
    {
      attributes: {
        "virtual_mcp.id": virtualMcp.id ?? "decopilot",
        "virtual_mcp.connection_count": connectionIds.length,
      },
    },
    async (span) => {
      try {
        const result = await Promise.all(
          connectionIds.map((connId) =>
            ctx.storage.connections.findById(connId),
          ),
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

  // Filter out inactive connections and self-referencing VIRTUAL connections
  const loadedConnections = allConnections.filter(
    (conn): conn is ConnectionEntity =>
      conn !== null &&
      conn.status === "active" &&
      !isSelfReferencingVirtual(conn, virtualMcp.id),
  );

  // Prepend caller-provided connections (e.g. the ephemeral dev-server
  // connection for a dev-capable agent). Prepended so their tools win the
  // aggregator's first-occurrence-wins dedup over any same-named tool.
  if (options?.additionalConnections?.length) {
    loadedConnections.unshift(...options.additionalConnections);
  }

  // Org-shared repo connections ("Add repo" in the sidebar) are available to
  // every agent by default. Appended (not the agent's own, so all their tools
  // are exposed), deduped, and guarded on a real org so the well-known agents
  // (Decopilot/brand-context, which resolve with no org) don't fan them in.
  // ponytail: one slug-filtered connections.list per client build; memoize in
  // createRequestCachedVirtualMcps like virtualMcps.list if this path gets hot.
  if (virtualMcp.organization_id) {
    const existingIds = new Set(loadedConnections.map((c) => c.id));
    const { items } = await ctx.storage.connections.list(
      virtualMcp.organization_id,
      { slug: "mcp-github" },
    );
    for (const conn of items) {
      if (
        conn.status === "active" &&
        !existingIds.has(conn.id) &&
        isOrgSharedConnection(conn)
      ) {
        loadedConnections.push(conn);
      }
    }
  }

  // Agent runtimes opt into the skill catalog: enumerate the org's skills now
  // (async — the sync getInstructions() can't) and stash the rendered block so
  // it reaches both the cluster engine and the desktop daemon. Cheap: the
  // public portion is cached process-wide. Skipped for non-agent consumers
  // (e.g. the home-next-actions prompt poll).
  const skillsBlock = options?.includeSkillsCatalog
    ? ((await renderSkillsCatalogBlock(ctx, virtualMcp)) ?? undefined)
    : undefined;

  // Build aggregator options
  const clientOptions: VirtualClientOptions = {
    connections: loadedConnections,
    virtualMcp,
    superUser,
    mcpListCache: getMcpListCache() ?? undefined,
    listTimeoutMs: options?.listTimeoutMs,
    skillsBlock,
  };

  return new PassthroughClient(clientOptions, ctx);
}

/**
 * Create the tool gateway for an ephemeral subagent backed by one concrete
 * MCP connection. No Virtual MCP row is created or required: the connection
 * itself supplies the subagent's complete MCP scope for this run.
 */
export function createConnectionClient(
  connection: ConnectionEntity,
  ctx: StudioContext,
  superUser = false,
  options?: { listTimeoutMs?: number },
): PassthroughClient {
  if (connection.connection_type === "VIRTUAL") {
    throw new Error(
      `Concrete MCP connection required, received Virtual MCP: ${connection.id}`,
    );
  }

  const description = connection.description?.trim();
  const instructions = [
    `You are an ephemeral specialist for the "${connection.title}" MCP connection (ID: ${connection.id}).`,
    description || undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");

  return new PassthroughClient(
    {
      connections: [connection],
      superUser,
      mcpListCache: getMcpListCache() ?? undefined,
      listTimeoutMs: options?.listTimeoutMs,
      instructions,
    },
    ctx,
  );
}

// Re-export types and utilities
export { type VirtualClientOptions } from "./types";
