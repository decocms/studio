/**
 * API_KEY_CREATE Tool
 *
 * Create a new API key with specified permissions.
 * IMPORTANT: The key value is only returned here and cannot be retrieved later.
 */

import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";
import { ApiKeyCreateInputSchema, ApiKeyCreateOutputSchema } from "./schema";

export const API_KEY_CREATE = defineTool({
  name: "API_KEY_CREATE",
  description:
    "Create an API key with scoped permissions. The key value is returned only once — store it immediately.",
  annotations: {
    title: "Create API Key",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },

  inputSchema: ApiKeyCreateInputSchema,
  outputSchema: ApiKeyCreateOutputSchema,

  handler: async (input, ctx) => {
    // Require authentication - users must be logged in to create API keys
    requireAuth(ctx);

    // Check authorization for this tool
    await ctx.access.check();

    // Create the API key via Better Auth with organization context
    // This ensures the API key is scoped to the current organization
    const result = await ctx.boundAuth.apiKey.create({
      name: input.name,
      permissions: input.permissions,
      expiresIn: input.expiresIn,
      metadata: {
        ...input.metadata,
        organization: ctx.organization, // Embed org context for multi-tenancy
      },
    });

    // Return the created key with its value (only time it's visible)
    // Convert dates to ISO strings for JSON Schema compatibility
    const expiresAt = result.expiresAt
      ? result.expiresAt instanceof Date
        ? result.expiresAt.toISOString()
        : result.expiresAt
      : null;
    const createdAt =
      result.createdAt instanceof Date
        ? result.createdAt.toISOString()
        : result.createdAt;

    const userId = getUserId(ctx);
    if (userId) {
      posthog.capture({
        distinctId: userId,
        event: "api_key_created",
        ...(ctx.organization?.id
          ? { groups: { organization: ctx.organization.id } }
          : {}),
        properties: {
          key_id: result.id,
          key_name: result.name ?? input.name,
          organization_id: ctx.organization?.id,
          has_expiry: !!expiresAt,
        },
      });
    }

    return {
      id: result.id,
      name: result.name ?? input.name, // Fallback to input name if null
      key: result.key, // This is the only time the key value is returned!
      permissions: result.permissions ?? {},
      expiresAt,
      createdAt,
    };
  },
});
