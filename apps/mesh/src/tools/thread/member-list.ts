/**
 * THREAD_MEMBERS_LIST Tool
 *
 * List all members who have been shared a thread.
 * Accessible by the thread owner and any current member.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

export const THREAD_MEMBERS_LIST = defineTool({
  name: "THREAD_MEMBERS_LIST",
  description: "List all members with access to a shared thread.",
  annotations: {
    title: "List Thread Members",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    thread_id: z.string().describe("ID of the thread"),
  }),
  outputSchema: z.object({
    members: z.array(
      z.object({
        user_id: z.string(),
        added_by: z.string(),
        added_at: z.string().datetime(),
      }),
    ),
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

    // Only the owner or a member can list members
    const isOwner = thread.created_by === callerId;
    const isMember = await ctx.storage.threads.isMember(
      input.thread_id,
      callerId,
    );
    if (!isOwner && !isMember) {
      throw new Error("Only thread members can view the member list");
    }

    const members = await ctx.storage.threads.listMembers(input.thread_id);

    return { members };
  },
});
