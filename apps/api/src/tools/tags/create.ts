/**
 * TAGS_CREATE Tool
 *
 * Create a new tag in an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const TAGS_CREATE = defineTool({
  name: "TAGS_CREATE",
  description:
    "Create a new tag, usable on organization members and task board items.",
  annotations: {
    title: "Create Tag",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z.string().min(1).max(50).describe("Tag name"),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional()
      .describe('Hex color the tag renders its dot with, e.g. "#3b82f6"'),
  }),

  outputSchema: z.object({
    tag: z.object({
      id: z.string(),
      organizationId: z.string(),
      name: z.string(),
      color: z.string().nullable(),
      createdAt: z.string().describe("ISO 8601 timestamp"),
    }),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organization = requireOrganization(ctx);
    const tag = await ctx.storage.tags.createTag(
      organization.id,
      input.name,
      input.color,
    );

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
