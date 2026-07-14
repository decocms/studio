import type { StudioContext } from "@/core/studio-context";

/** Throws if `assigneeId` is not a member of the organization. */
export async function assertValidAssignee(
  ctx: StudioContext,
  organizationId: string,
  assigneeId: string,
): Promise<void> {
  const { members } = await ctx.boundAuth.organization.listMembers({
    organizationId,
  });
  if (
    !members.some((member: { userId: string }) => member.userId === assigneeId)
  ) {
    throw new Error("assigneeId is not a member of the organization");
  }
}
