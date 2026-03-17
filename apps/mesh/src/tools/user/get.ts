/**
 * USER_GET Tool
 *
 * Fetch a user's public profile (name/email/avatar) by user id.
 * Access is restricted to users in shared organizations.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";

const InputSchema = z.object({
  id: z.string().min(1),
});

const OutputSchema = z.object({
  user: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      image: z.string().nullable(),
    })
    .nullable(),
});

export const USER_GET = defineTool({
  name: "USER_GET",
  description:
    "Get a user's profile by ID. Only returns users who share an organization with the caller.",
  annotations: {
    title: "Get User",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input, ctx) => {
    await ctx.access.check();
    requireAuth(ctx);

    const requesterUserId = getUserId(ctx);
    if (!requesterUserId) {
      throw new Error("Authentication required");
    }

    const user = await ctx.storage.users.findById(input.id, requesterUserId);
    if (!user) {
      return { user: null };
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image ?? null,
      },
    };
  },
});
