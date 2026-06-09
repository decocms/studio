/**
 * Workflows Plugin - Server Types
 *
 * Type definitions for the StudioContext shape used by workflow tools.
 * Tools receive StudioContext as `unknown` -- these types provide safe casting.
 */

import type { WorkflowPluginStorage } from "./storage";

/**
 * Minimal event bus interface exposed to workflow tools
 */
export interface WorkflowEventBus {
  publish(
    organizationId: string,
    publisherConnectionId: string,
    input: {
      type: string;
      subject?: string;
      data?: unknown;
      deliverAt?: string;
    },
  ): Promise<unknown>;
}

/**
 * MCP proxy interface (subset of Client from @modelcontextprotocol/sdk)
 */
export interface MCPProxy {
  callTool: (
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ) => Promise<{
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  close: () => Promise<void>;
}

/**
 * StudioContext shape available to workflow tools.
 *
 * This is a subset of the full StudioContext -- only the parts workflows need.
 */
export interface WorkflowStudioContext {
  organization: { id: string; slug?: string; name?: string };
  auth: {
    user: { id: string; email?: string } | null;
  };
  access: {
    check: () => Promise<void>;
  };
  eventBus: WorkflowEventBus;
  connectionId?: string;
  createMCPProxy: (connectionId: string) => Promise<MCPProxy>;
}

/**
 * Cast unknown ctx to WorkflowStudioContext.
 * Throws if organization context is missing.
 */
export function requireWorkflowContext(ctx: unknown): WorkflowStudioContext {
  const meshCtx = ctx as WorkflowStudioContext;
  if (!meshCtx.organization) {
    throw new Error("Organization context required for workflow tools");
  }
  return meshCtx;
}

// ============================================================================
// Shared utilities
// ============================================================================

/**
 * Safely parse a JSON value that may be a string (from DB) or already parsed.
 */
export function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ============================================================================
// Plugin storage singleton (set during plugin initialization)
// ============================================================================

let pluginStorage: WorkflowPluginStorage | null = null;

export function setPluginStorage(storage: WorkflowPluginStorage): void {
  pluginStorage = storage;
}

export function getPluginStorage(): WorkflowPluginStorage {
  if (!pluginStorage) {
    throw new Error(
      'Plugin storage not initialized. Make sure the "workflows" plugin is enabled.',
    );
  }
  return pluginStorage;
}
