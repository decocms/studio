/**
 * API_KEY_DELETE Tool
 *
 * Delete an API key (instant revocation).
 * Only allows deleting keys that belong to the current organization.
 */

import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";
import { ApiKeyDeleteInputSchema, ApiKeyDeleteOutputSchema } from "./schema";

// Type for API key metadata with organization
interface ApiKeyMetadata {
  organization?: {
    id: string;
    slug?: string;
    name?: string;
  };
  [key: string]: unknown;
}

export const API_KEY_DELETE = defineTool({
  name: "API_KEY_DELETE",
  description: "Delete and instantly revoke an API key. Cannot be undone.",
  annotations: {
    title: "Delete API Key",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: ApiKeyDeleteInputSchema,
  outputSchema: ApiKeyDeleteOutputSchema,

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization for this tool
    await ctx.access.check();

    // Get the current user ID for ownership verification
    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to delete API key");
    }

    // First, list all keys to find the target key and verify organization ownership
    const allKeys = await ctx.boundAuth.apiKey.list();
    const targetKey = allKeys?.find((k) => k.id === input.keyId);

    if (!targetKey) {
      throw new Error("API key not found");
    }

    // Verify key belongs to current organization (multi-tenancy check)
    const metadata = targetKey.metadata as ApiKeyMetadata | undefined;
    const keyOrgId = metadata?.organization?.id;
    const currentOrgId = ctx.organization?.id;

    if (keyOrgId !== currentOrgId) {
      throw new Error("Cannot delete API key from another organization");
    }

    // Delete the API key via Better Auth
    await ctx.boundAuth.apiKey.delete(input.keyId);

    return {
      success: true,
      keyId: input.keyId,
    };
  },
});
