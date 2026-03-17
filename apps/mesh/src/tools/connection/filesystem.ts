/**
 * Filesystem Connection Utilities
 *
 * Shared utilities for the S3-backed filesystem connection.
 * This connection is injected when S3 is configured to provide
 * filesystem functionality for AI agents.
 */

import { FILESYSTEM_BINDING } from "@decocms/bindings/filesystem";
import {
  getWellKnownFilesystemConnection,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { z } from "zod";
import { isFilesystemConfigured } from "../../filesystem/factory";
import { type ConnectionEntity, type ToolDefinition } from "./schema";

/**
 * Cached tool definitions for filesystem connection.
 * Computed once at module load time to avoid repeated z.toJSONSchema conversions.
 */
const FILESYSTEM_TOOLS: ToolDefinition[] = FILESYSTEM_BINDING.map(
  (binding: (typeof FILESYSTEM_BINDING)[number]) => ({
    name: binding.name,
    description: `${binding.name} operation for S3-backed filesystem`,
    inputSchema: z.toJSONSchema(binding.inputSchema) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(binding.outputSchema) as Record<
      string,
      unknown
    >,
  }),
);

/**
 * Check if a connection ID is the filesystem connection for an organization
 */
export function isFilesystemConnection(
  connectionId: string,
  organizationId: string,
): boolean {
  return connectionId === WellKnownOrgMCPId.FILESYSTEM(organizationId);
}

/**
 * Create a filesystem connection entity for S3-backed file storage.
 * This is injected when S3 is configured to provide filesystem
 * functionality for AI agents.
 */
export function createFilesystemConnectionEntity(
  orgId: string,
  baseUrl: string,
): ConnectionEntity {
  const connectionData = getWellKnownFilesystemConnection(baseUrl, orgId);

  const now = new Date().toISOString();

  return {
    id: connectionData.id ?? WellKnownOrgMCPId.FILESYSTEM(orgId),
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
    tools: FILESYSTEM_TOOLS,
    bindings: ["FILESYSTEM"],
    status: "active",
  };
}

export { isFilesystemConfigured };
