/**
 * Dev Assets Connection Utilities
 *
 * Shared utilities for the dev-only local file storage connection.
 * This connection is injected in dev mode to provide object storage
 * functionality without requiring an external S3 bucket.
 */

import { env } from "../../env";
import { OBJECT_STORAGE_BINDING } from "@decocms/bindings/object-storage";
import {
  getWellKnownDevAssetsConnection,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { z } from "zod";
import { type ConnectionEntity, type ToolDefinition } from "./schema";

/**
 * Cached tool definitions for dev-assets connection.
 * Computed once at module load time to avoid repeated z.toJSONSchema conversions.
 */
const DEV_ASSETS_TOOLS: ToolDefinition[] = OBJECT_STORAGE_BINDING.map(
  (binding: (typeof OBJECT_STORAGE_BINDING)[number]) => ({
    name: binding.name,
    description: `${binding.name} operation for local file storage`,
    inputSchema: z.toJSONSchema(
      binding.inputSchema,
    ) as ToolDefinition["inputSchema"],
    outputSchema: z.toJSONSchema(
      binding.outputSchema,
    ) as ToolDefinition["outputSchema"],
  }),
);

/**
 * Check if we're running in dev mode
 */
export function isDevMode(): boolean {
  return env.NODE_ENV !== "production";
}

/**
 * Check if a connection ID is the dev-assets connection for an organization
 */
export function isDevAssetsConnection(
  connectionId: string,
  organizationId: string,
): boolean {
  return connectionId === WellKnownOrgMCPId.DEV_ASSETS(organizationId);
}

/**
 * Create a dev-assets connection entity for local file storage.
 * This is injected in dev mode to provide object storage functionality
 * without requiring an external S3 bucket.
 */
export function createDevAssetsConnectionEntity(
  orgId: string,
  baseUrl: string,
): ConnectionEntity {
  const connectionData = getWellKnownDevAssetsConnection(baseUrl, orgId);

  const now = new Date().toISOString();

  return {
    id: connectionData.id ?? WellKnownOrgMCPId.DEV_ASSETS(orgId),
    title: connectionData.title,
    description: connectionData.description ?? null,
    icon: connectionData.icon ?? null,
    app_name: connectionData.app_name ?? null,
    app_id: connectionData.app_id ?? null,
    organization_id: orgId,
    created_by: "system",
    created_at: now,
    updated_at: now,
    connection_type: connectionData.connection_type,
    connection_url: connectionData.connection_url ?? null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: connectionData.metadata ?? null,
    tools: DEV_ASSETS_TOOLS,
    bindings: ["OBJECT_STORAGE"],
    status: "active",
  };
}
