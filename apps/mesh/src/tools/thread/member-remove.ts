/**
 * THREAD_MEMBER_REMOVE Tool
 *
 * Remove a member from a shared thread.
 * Any existing member (or the owner) can remove members.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

export const THREAD_MEMBER_REMOVE = defineTool({
  name: "THREAD_MEMBER_REMOVE",
  description:
    "Remove a member from a shared thread. Any current member or the thread owner can remove others.",
  annotations: {
    title: "Remove Thread Member",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    thread_id: z.string().describe("ID of the thread"),
    user_id: z.string().describe("User ID of the member to remove"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (input, ctx) => {
    await ctx.access.check();

    const callerId = ctx.auth.user?.id;
    if (!callerId) {
      throw new Error("Authentication required");
    }

    const organization = requireOrganization(ctx);

    // Verify thread exists and belongs to this org
    const thread = await ctx.storage.threads.get(input.thread_id);
    if (!thread || thread.organization_id !== organization.id) {
      throw new Error("Thread not found");
    }

    // Only the owner or an existing member can remove members
    const isOwner = thread.created_by === callerId;
    const isMember = await ctx.storage.threads.isMember(
      input.thread_id,
      callerId,
    );
    if (!isOwner && !isMember) {
      throw new Error("Only thread members can remove other members");
    }

    await ctx.storage.threads.removeMember(input.thread_id, input.user_id);

    return { success: true };
  },
});
