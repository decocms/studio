/**
 * API_KEY_UPDATE Tool
 *
 * Update an existing API key's name, permissions, or metadata.
 * Only allows updating keys that belong to the current organization.
 */

import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";
import { ApiKeyUpdateInputSchema, ApiKeyUpdateOutputSchema } from "./schema";

// Type for API key metadata with organization
interface ApiKeyMetadata {
  organization?: {
    id: string;
    slug?: string;
    name?: string;
  };
  [key: string]: unknown;
}

export const API_KEY_UPDATE = defineTool({
  name: "API_KEY_UPDATE",
  description:
    "Update an API key's name, permissions, or metadata. The key value cannot be changed or retrieved.",
  annotations: {
    title: "Update API Key",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: ApiKeyUpdateInputSchema,
  outputSchema: ApiKeyUpdateOutputSchema,

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization for this tool
    await ctx.access.check();

    // Get the current user ID for ownership verification
    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to update API key");
    }

    // First, list all keys to find the target key and verify organization ownership
    const allKeys = await ctx.boundAuth.apiKey.list();
    const targetKey = allKeys?.find((k) => k.id === input.keyId);

    if (!targetKey) {
      throw new Error(`API key not found: ${input.keyId}`);
    }

    // Verify key belongs to current organization (multi-tenancy check)
    const metadata = targetKey.metadata as ApiKeyMetadata | undefined;
    const keyOrgId = metadata?.organization?.id;
    const currentOrgId = ctx.organization?.id;

    if (keyOrgId !== currentOrgId) {
      throw new Error("Cannot update API key from another organization");
    }

    // Update the API key via Better Auth
    // Preserve the organization in metadata to prevent org change
    const result = await ctx.boundAuth.apiKey.update({
      keyId: input.keyId,
      name: input.name,
      permissions: input.permissions,
      metadata: {
        ...input.metadata,
        organization: ctx.organization, // Preserve org context
      },
    });

    if (!result) {
      throw new Error(`Failed to update API key: ${input.keyId}`);
    }

    // Return the updated key (without key value)
    // Convert dates to ISO strings for JSON Schema compatibility
    return {
      item: {
        id: result.id,
        name: result.name ?? input.name ?? "Unnamed Key", // Fallback if name is null
        userId: result.userId,
        permissions: result.permissions ?? {},
        expiresAt: result.expiresAt
          ? result.expiresAt instanceof Date
            ? result.expiresAt.toISOString()
            : result.expiresAt
          : null,
        createdAt:
          result.createdAt instanceof Date
            ? result.createdAt.toISOString()
            : result.createdAt,
      },
    };
  },
});
