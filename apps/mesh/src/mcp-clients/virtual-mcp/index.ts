/**
 * Virtual MCP Client
 *
 * Factory functions for creating MCP clients from Virtual MCP entities.
 * Shared between Virtual MCP routes and proxy routes for VIRTUAL connections.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isDecopilot } from "@decocms/mesh-sdk";
import { SpanStatusCode } from "@opentelemetry/api";
import { getMcpListCache } from "../mcp-list-cache";
import type { StudioContext } from "../../core/studio-context";
import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import { loadInstructionsFileText } from "./instructions-file";
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
 * @param ctx - Mesh context for creating proxies
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
 * @param ctx - Mesh context for creating proxies
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

  // Agent runtimes opt into the skill catalog: enumerate the org's skills now
  // (async — the sync getInstructions() can't) and stash the rendered block so
  // it reaches both the cluster engine and the desktop daemon. Cheap: the
  // public portion is cached process-wide. Skipped for non-agent consumers
  // (e.g. the home-next-actions prompt poll).
  const skillsBlock = options?.includeSkillsCatalog
    ? ((await renderSkillsCatalogBlock(ctx, virtualMcp)) ?? undefined)
    : undefined;

  // Prompt-linked-to-file: read the linked org-fs file now (async, same seam
  // as the skills block) so getInstructions() can prefer it over the inline
  // mirror on every run path. No-op (no read) for agents without a link.
  const instructionsOverride =
    (await loadInstructionsFileText(ctx, virtualMcp)) ?? undefined;

  // Build aggregator options
  const clientOptions: VirtualClientOptions = {
    connections: loadedConnections,
    virtualMcp,
    superUser,
    mcpListCache: getMcpListCache() ?? undefined,
    listTimeoutMs: options?.listTimeoutMs,
    skillsBlock,
    instructionsOverride,
  };

  return new PassthroughClient(clientOptions, ctx);
}

// Re-export types and utilities
export { type VirtualClientOptions } from "./types";
