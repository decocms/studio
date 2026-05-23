/**
 * Workflows Plugin - Mesh-side type contracts.
 *
 * MeshContext shape, runtime context validation, and the plugin's storage
 * singleton accessor used by tools. Engine internals live in
 * `@decocms/workflow-engine`; this file only carries the mesh-specific
 * adapters that need to stay co-located with the tools.
 */

import type { WorkflowEngineStorage, MCPProxy } from "@decocms/workflow-engine";

export type WorkflowPluginStorage = WorkflowEngineStorage;

export { parseJson } from "@decocms/workflow-engine";
export type { MCPProxy } from "@decocms/workflow-engine";

/**
 * Minimal event bus interface exposed to workflow tools.
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
 * MeshContext shape available to workflow tools. A subset of the full
 * MeshContext — only the parts workflows need.
 */
export interface WorkflowMeshContext {
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
 * Cast unknown ctx to WorkflowMeshContext. Throws if organization context
 * is missing.
 */
export function requireWorkflowContext(ctx: unknown): WorkflowMeshContext {
  const meshCtx = ctx as WorkflowMeshContext;
  if (!meshCtx.organization) {
    throw new Error("Organization context required for workflow tools");
  }
  return meshCtx;
}

// ============================================================================
// Plugin storage singleton (populated during plugin createStorage())
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
