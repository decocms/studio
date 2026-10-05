import type { StudioContext } from "@/core/studio-context";
import { SUPER_AGENT_ASSIGNEE_ID } from "./schema";

/**
 * Throws if `assigneeId` is not a member of the organization.
 *
 * Reads the member table rather than Better Auth's listMembers, which needs a
 * cookie session and rejects agent JWT, MCP OAuth, and automation callers.
 */
export async function assertValidAssignee(
  ctx: Pick<StudioContext, "db">,
  organizationId: string,
  assigneeId: string,
): Promise<void> {
  // The Super Agent is a valid assignee but not an org member.
  if (assigneeId === SUPER_AGENT_ASSIGNEE_ID) return;

  const member = await ctx.db
    .selectFrom("member")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("userId", "=", assigneeId)
    .executeTakeFirst();
  if (!member) {
    throw new Error("assigneeId is not a member of the organization");
  }
}
