/**
 * Virtual MCP Client
 *
 * Factory functions for creating MCP clients from Virtual MCP entities.
 * Shared between Virtual MCP routes and proxy routes for VIRTUAL connections.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isDecopilot } from "@decocms/mesh-sdk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { getMcpListCache } from "../mcp-list-cache";
import type { MeshContext } from "../../core/mesh-context";
import {
  resolveSlot,
  SlotResolutionCache,
  SlotUnresolvedError,
} from "../../core/slot-resolver";
import type { ConnectionEntity } from "../../tools/connection/schema";
import type {
  VirtualMCPConnection,
  VirtualMCPEntity,
} from "../../tools/virtual/schema";
import { PassthroughClient } from "./passthrough-client";
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
  ctx: MeshContext,
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
  ctx: MeshContext,
  _strategy: "passthrough",
  superUser = false,
  options?: { listTimeoutMs?: number },
): Promise<PassthroughClient> {
  // Inclusion mode: use only the connections specified in virtual MCP
  const connectionIds = virtualMcp.connections.map((c) => c.connection_id);

  // Load all connections in parallel
  const allConnections = await ctx.tracer.startActiveSpan(
    "mesh.virtual_mcp.load_connections",
    {
      attributes: {
        "virtual_mcp.id": virtualMcp.id ?? "decopilot",
        "virtual_mcp.connection_count": connectionIds.length,
      },
    },
    async (span) => {
      try {
        // Internal infrastructure path — the virtual MCP loader must see every
        // connection referenced by the agent regardless of access. Per-user
        // visibility is enforced upstream by the agent's own access checks and
        // by the slot resolver (see slot resolution block below).
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

  // ---------------------------------------------------------------------
  // Slot resolution
  // ---------------------------------------------------------------------
  // For every typed slot declared on the agent, look up the caller's
  // matching connection (user-private preferred, org-shared fallback) and
  // augment both the loaded ConnectionEntity[] and the per-connection
  // selection metadata that the PassthroughClient consumes. Resolved slots
  // are indistinguishable from concrete child connections downstream — the
  // PassthroughClient just sees one more connection_id with its
  // selected_tools / selected_resources / selected_prompts.
  // ---------------------------------------------------------------------
  const resolvedConnections: ConnectionEntity[] = [...loadedConnections];
  const resolvedVMCPConnections: VirtualMCPConnection[] = [
    ...virtualMcp.connections,
  ];

  if (virtualMcp.slots.length > 0) {
    const invokerUserId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null;
    const slotCache = new SlotResolutionCache();
    const activeSpan = trace.getActiveSpan();

    for (const slot of virtualMcp.slots) {
      if (!invokerUserId) {
        throw new SlotUnresolvedError(slot.slot_app_id);
      }

      const resolved = await slotCache.resolve(
        invokerUserId,
        slot.slot_app_id,
        () =>
          resolveSlot(ctx.db, {
            organizationId: virtualMcp.organization_id,
            invokerUserId,
            appId: slot.slot_app_id,
          }),
      );
      if (!resolved) {
        throw new SlotUnresolvedError(slot.slot_app_id);
      }

      const resolvedEntity = await ctx.storage.connections.findById(
        resolved.connectionId,
        virtualMcp.organization_id,
      );
      if (!resolvedEntity) {
        // Defensive: resolver pointed at a row that disappeared (e.g.
        // deleted between the resolveSlot SELECT and this findById). Treat
        // as unresolved so the UI prompts the user to reconnect.
        throw new SlotUnresolvedError(slot.slot_app_id);
      }

      resolvedConnections.push(resolvedEntity);
      resolvedVMCPConnections.push({
        connection_id: resolved.connectionId,
        selected_tools: slot.selected_tools,
        selected_resources: slot.selected_resources,
        selected_prompts: slot.selected_prompts,
      });

      if (activeSpan) {
        activeSpan.setAttribute(
          `slot.${slot.slot_app_id}.app_id`,
          slot.slot_app_id,
        );
        activeSpan.setAttribute(
          `slot.${slot.slot_app_id}.connection_id`,
          resolved.connectionId,
        );
        activeSpan.setAttribute(
          `slot.${slot.slot_app_id}.access`,
          resolved.access,
        );
      }
    }
  }

  // Build aggregator options. Note: we pass an *augmented* VirtualMCPEntity
  // whose `connections` array contains both the agent's concrete children
  // and the resolved-slot connections, so PassthroughClient's vmcpConnMap
  // sees a single uniform list keyed by connection_id.
  const clientOptions: VirtualClientOptions = {
    connections: resolvedConnections,
    virtualMcp: {
      ...virtualMcp,
      connections: resolvedVMCPConnections,
    },
    superUser,
    mcpListCache: getMcpListCache() ?? undefined,
    listTimeoutMs: options?.listTimeoutMs,
  };

  return new PassthroughClient(clientOptions, ctx);
}

// Re-export types and utilities
export { type VirtualClientOptions } from "./types";
