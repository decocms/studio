/**
 * ORGANIZATION_MEMBER_LIST Tool
 *
 * List all members in an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";

export const ORGANIZATION_MEMBER_LIST = defineTool({
  name: "ORGANIZATION_MEMBER_LIST",
  description: "List all members in the organization with their roles.",
  annotations: {
    title: "List Organization Members",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  }),

  outputSchema: z.object({
    members: z.array(
      z.object({
        id: z.string(),
        organizationId: z.string(),
        userId: z.string(),
        role: z.string(),
        createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
        user: z
          .object({
            id: z.string(),
            name: z.string(),
            email: z.string(),
            image: z.string().optional(),
          })
          .optional(),
      }),
    ),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();
    // Use active organization if not specified
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // Better Auth's listMembers needs a cookie session; agent and MCP callers have none.
    const rows = await ctx.db
      .selectFrom("member")
      .innerJoin("user", "user.id", "member.userId")
      .select([
        "member.id as id",
        "member.organizationId as organizationId",
        "member.userId as userId",
        "member.role as role",
        "member.createdAt as createdAt",
        "user.name as name",
        "user.email as email",
        "user.image as image",
      ])
      .where("member.organizationId", "=", organizationId)
      .orderBy("member.createdAt", "asc")
      .orderBy("member.id", "asc")
      .limit(input.limit ?? 100)
      .offset(input.offset ?? 0)
      .execute();

    const members = rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      role: row.role,
      createdAt: new Date(row.createdAt).toISOString(),
      user: {
        id: row.userId,
        name: row.name,
        email: row.email,
        image: row.image ?? undefined,
      },
    }));

    return { members };
  },
});
