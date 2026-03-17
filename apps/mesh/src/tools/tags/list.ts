/**
 * TAGS_LIST Tool
 *
 * List all tags in an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const TAGS_LIST = defineTool({
  name: "TAGS_LIST",
  description: "List all tags available in the organization.",
  annotations: {
    title: "List Tags",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),

  outputSchema: z.object({
    tags: z.array(
      z.object({
        id: z.string(),
        organizationId: z.string(),
        name: z.string(),
        createdAt: z.string().describe("ISO 8601 timestamp"),
      }),
    ),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organization = requireOrganization(ctx);
    const tags = await ctx.storage.tags.listOrgTags(organization.id);

    return {
      tags: tags.map((tag) => ({
        ...tag,
        createdAt:
          tag.createdAt instanceof Date
            ? tag.createdAt.toISOString()
            : String(tag.createdAt),
      })),
    };
  },
});
