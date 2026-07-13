import type { StudioContext } from "@/core/studio-context";

/** Throws if `assigneeId` is not a member of the organization. */
export async function assertValidAssignee(
  ctx: StudioContext,
  organizationId: string,
  assigneeId: string,
): Promise<void> {
  const result = await ctx.boundAuth.organization.listMembers({
    organizationId,
  });
  const members = Array.isArray(result) ? result : [];
  if (!members.some((member) => member.userId === assigneeId)) {
    throw new Error("assigneeId is not a member of the organization");
  }
}
