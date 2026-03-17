/**
 * API Key Schemas
 *
 * Zod schemas for API key entities and operations.
 * Note: API key values are only returned at creation time.
 */

import { z } from "zod";

// ============================================================================
// Permission Schema
// ============================================================================

/**
 * Permission schema - Better Auth format: { resource: [actions] }
 *
 * Resource types:
 * - "self": Management API tools (organization-level operations)
 * - "conn_<UUID>": Proxy API tools (connection-specific operations)
 *
 * Actions: Array of tool names or "*" for all permissions
 *
 * Examples:
 * - { "self": ["API_KEY_CREATE", "CONNECTIONS_LIST"] }
 * - { "conn_abc123": ["SEND_MESSAGE", "LIST_THREADS"] }
 * - { "self": ["*"] } (all management tools)
 * - { "conn_abc123": ["*"] } (all tools for specific connection)
 */
const PermissionSchema = z.record(z.string(), z.array(z.string()));

export type Permission = z.infer<typeof PermissionSchema>;

// ============================================================================
// API Key Entity Schema (for list operations - no key value)
// ============================================================================

/**
 * API Key entity schema - returned in list operations
 * Does NOT include the actual key value (security requirement)
 */
const ApiKeyEntitySchema = z.object({
  id: z.string().describe("Unique identifier for the API key"),
  name: z.string().describe("Human-readable name for the API key"),
  userId: z.string().describe("ID of the user who owns this API key"),
  permissions: PermissionSchema.describe(
    'Permissions granted to this API key. Format: { resource: [actions] } where resource is "self" for management tools or "conn_<UUID>" for connection-specific tools. Example: { "self": ["API_KEY_CREATE"], "conn_abc123": ["SEND_MESSAGE"] }',
  ),
  expiresAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .describe("Expiration date of the API key (ISO 8601)"),
  createdAt: z
    .string()
    .datetime()
    .describe("When the API key was created (ISO 8601)"),
  // Note: key value is never returned after creation
});

export type ApiKeyEntity = z.infer<typeof ApiKeyEntitySchema>;

// ============================================================================
// API Key Create Schemas
// ============================================================================

/**
 * Input schema for creating an API key
 */
export const ApiKeyCreateInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("Human-readable name for the API key"),
  permissions: PermissionSchema.optional().describe(
    'Permissions to grant. Format: { resource: [actions] }. Resource is "self" for management tools or "conn_<UUID>" for connection-specific tools. Actions are tool names (e.g., ["API_KEY_CREATE"]) or ["*"] for all. Example: { "self": ["API_KEY_CREATE", "CONNECTIONS_LIST"] }. Defaults to read-only permissions.',
  ),
  expiresIn: z
    .number()
    .positive()
    .optional()
    .describe(
      "Expiration time in seconds. If not provided, key never expires.",
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional metadata to store with the API key"),
});

export type ApiKeyCreateInput = z.infer<typeof ApiKeyCreateInputSchema>;

/**
 * Output schema for API key creation
 * IMPORTANT: This is the ONLY time the key value is returned!
 */
export const ApiKeyCreateOutputSchema = z.object({
  id: z.string().describe("Unique identifier for the API key"),
  name: z.string().describe("Human-readable name for the API key"),
  key: z
    .string()
    .describe(
      "The actual API key value. STORE THIS SECURELY - it will not be shown again!",
    ),
  permissions: PermissionSchema.describe(
    'Permissions granted to this API key. Format: { resource: [actions] } where resource is "self" for management tools or "conn_<UUID>" for connection-specific tools',
  ),
  expiresAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .describe("Expiration date of the API key (ISO 8601)"),
  createdAt: z
    .string()
    .datetime()
    .describe("When the API key was created (ISO 8601)"),
});

export type ApiKeyCreateOutput = z.infer<typeof ApiKeyCreateOutputSchema>;

// ============================================================================
// API Key List Schemas
// ============================================================================

/**
 * Input schema for listing API keys
 */
export const ApiKeyListInputSchema = z.object({
  // No input parameters needed - lists all keys for the authenticated user
});

export type ApiKeyListInput = z.infer<typeof ApiKeyListInputSchema>;

/**
 * Output schema for listing API keys
 */
export const ApiKeyListOutputSchema = z.object({
  items: z
    .array(ApiKeyEntitySchema)
    .describe("List of API keys (without key values)"),
});

export type ApiKeyListOutput = z.infer<typeof ApiKeyListOutputSchema>;

// ============================================================================
// API Key Update Schemas
// ============================================================================

/**
 * Input schema for updating an API key
 */
export const ApiKeyUpdateInputSchema = z.object({
  keyId: z.string().describe("ID of the API key to update"),
  name: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("New name for the API key"),
  permissions: PermissionSchema.optional().describe(
    'New permissions. Format: { resource: [actions] } where resource is "self" for management tools or "conn_<UUID>" for connection-specific tools. Actions are tool names or "*" for all. Example: { "self": ["API_KEY_CREATE"] }. Replaces existing permissions.',
  ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("New metadata. Replaces existing metadata."),
});

export type ApiKeyUpdateInput = z.infer<typeof ApiKeyUpdateInputSchema>;

/**
 * Output schema for API key update
 */
export const ApiKeyUpdateOutputSchema = z.object({
  item: ApiKeyEntitySchema.describe("The updated API key (without key value)"),
});

export type ApiKeyUpdateOutput = z.infer<typeof ApiKeyUpdateOutputSchema>;

// ============================================================================
// API Key Delete Schemas
// ============================================================================

/**
 * Input schema for deleting an API key
 */
export const ApiKeyDeleteInputSchema = z.object({
  keyId: z.string().describe("ID of the API key to delete"),
});

export type ApiKeyDeleteInput = z.infer<typeof ApiKeyDeleteInputSchema>;

/**
 * Output schema for API key deletion
 */
export const ApiKeyDeleteOutputSchema = z.object({
  success: z.boolean().describe("Whether the deletion was successful"),
  keyId: z.string().describe("ID of the deleted API key"),
});

export type ApiKeyDeleteOutput = z.infer<typeof ApiKeyDeleteOutputSchema>;
