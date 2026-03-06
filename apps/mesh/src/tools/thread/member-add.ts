/**
 * THREAD_MEMBER_ADD Tool
 *
 * Share a thread with an org member, granting them read-only access.
 * Only the thread owner can add members.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

export const THREAD_MEMBER_ADD = defineTool({
  name: "THREAD_MEMBER_ADD",
  description:
    "Share a thread with an org member, granting them read-only access. Only the thread owner can add members.",
  annotations: {
    title: "Add Thread Member",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    thread_id: z.string().describe("ID of the thread to share"),
    user_id: z.string().describe("User ID of the org member to add"),
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

    // Only the thread owner can add members
    if (thread.created_by !== callerId) {
      throw new Error("Only the thread owner can add members");
    }

    // Verify the target user is in the same org
    const orgResult = await ctx.boundAuth.organization.listMembers({
      organizationId: organization.id,
    });
    const members = Array.isArray(orgResult)
      ? orgResult
      : ((orgResult as { members?: { userId: string }[] })?.members ?? []);
    const targetIsOrgMember = members.some((m) => m.userId === input.user_id);
    if (!targetIsOrgMember) {
      throw new Error("User is not a member of this organization");
    }

    // Prevent adding the owner as a member (they already have full access)
    if (input.user_id === thread.created_by) {
      throw new Error("Thread owner already has access");
    }

    await ctx.storage.threads.addMember(
      input.thread_id,
      input.user_id,
      callerId,
    );

    return { success: true };
  },
});
