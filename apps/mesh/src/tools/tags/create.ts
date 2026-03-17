/**
 * TAGS_CREATE Tool
 *
 * Create a new tag in an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const TAGS_CREATE = defineTool({
  name: "TAGS_CREATE",
  description: "Create a new tag that can be assigned to organization members.",
  annotations: {
    title: "Create Tag",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z.string().min(1).max(50).describe("Tag name"),
  }),

  outputSchema: z.object({
    tag: z.object({
      id: z.string(),
      organizationId: z.string(),
      name: z.string(),
      createdAt: z.string().describe("ISO 8601 timestamp"),
    }),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organization = requireOrganization(ctx);
    const tag = await ctx.storage.tags.createTag(organization.id, input.name);

    return {
      tag: {
        ...tag,
        createdAt:
          tag.createdAt instanceof Date
            ? tag.createdAt.toISOString()
            : String(tag.createdAt),
      },
    };
  },
});
