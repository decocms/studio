/**
 * API_KEY_LIST Tool
 *
 * List all API keys for the current user in the current organization.
 * Note: Key values are never returned - only metadata.
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import {
  ApiKeyListInputSchema,
  ApiKeyListOutputSchema,
  type ApiKeyEntity,
} from "./schema";

// Type for API key metadata with organization
interface ApiKeyMetadata {
  organization?: {
    id: string;
    slug?: string;
    name?: string;
  };
  [key: string]: unknown;
}

export const API_KEY_LIST = defineTool({
  name: "API_KEY_LIST",
  description:
    "List API keys for the current user. Returns metadata only — key values are never shown after creation.",
  annotations: {
    title: "List API Keys",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: ApiKeyListInputSchema,
  outputSchema: ApiKeyListOutputSchema,

  handler: async (_input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization for this tool
    await ctx.access.check();

    // List API keys via Better Auth
    const result = await ctx.boundAuth.apiKey.list();

    // Get current organization ID for filtering
    const currentOrgId = ctx.organization?.id;

    // Filter to only show keys belonging to current organization
    // and map to our entity schema (ensuring no key values are exposed)
    const items: ApiKeyEntity[] = (result ?? [])
      .filter((key) => {
        const metadata = key.metadata as ApiKeyMetadata | undefined;
        const keyOrgId = metadata?.organization?.id;
        // Only include keys that belong to the current organization
        return keyOrgId === currentOrgId;
      })
      .map((key) => ({
        id: key.id,
        name: key.name ?? "Unnamed Key", // Fallback if name is null
        userId: key.userId,
        permissions: key.permissions ?? {},
        expiresAt: key.expiresAt
          ? key.expiresAt instanceof Date
            ? key.expiresAt.toISOString()
            : key.expiresAt
          : null,
        createdAt:
          key.createdAt instanceof Date
            ? key.createdAt.toISOString()
            : key.createdAt,
      }));

    return {
      items,
    };
  },
});
