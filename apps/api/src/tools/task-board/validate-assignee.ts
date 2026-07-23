import type { StudioContext } from "@/core/studio-context";
import { SUPER_AGENT_ASSIGNEE_ID } from "./schema";

/** Throws if `assigneeId` is not a member of the organization. */
export async function assertValidAssignee(
  ctx: StudioContext,
  organizationId: string,
  assigneeId: string,
): Promise<void> {
  // The Super Agent is a valid assignee but not an org member.
  if (assigneeId === SUPER_AGENT_ASSIGNEE_ID) return;

  // Filter server-side on the exact userId rather than paging through every
  // member — an unfiltered listMembers() caps at 100 rows (Better Auth's
  // default membershipLimit), so it would silently miss a valid assignee in
  // an organization with more than 100 members.
  const { members } = await ctx.boundAuth.organization.listMembers({
    organizationId,
    filterField: "userId",
    filterValue: assigneeId,
  });
  if (
    !members.some((member: { userId: string }) => member.userId === assigneeId)
  ) {
    throw new Error("assigneeId is not a member of the organization");
  }
}
