import type { StudioContext } from "@/core/studio-context";
import { getDecopilotId } from "@decocms/mesh-sdk";
import { SUPER_AGENT_ASSIGNEE_ID } from "./schema";

/**
 * An agent a task can be delegated to. Assigning a task to one of these
 * enqueues a run of that agent on the task (see `enqueue-agent.ts`).
 * `id` is the Virtual MCP id dispatched on the run's thread — the well-known
 * Decopilot id for the Super Agent, or the code agent's own id.
 */
export type DelegatedAgent = { id: string; title: string };

/**
 * A code agent is a Virtual MCP backed by a clonable GitHub repo. Mirrors the
 * web `agentHasClonableSource`, inlined to avoid importing web code (same
 * precedent as `storage/task-board.ts`'s `threadHasClonableRepo`). `metadata`
 * from `findById` is already a parsed object, so no JSON.parse branch is needed.
 */
function agentMetadataHasClonableRepo(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  const meta = metadata as { githubRepo?: { url?: unknown } | null };
  const url = meta.githubRepo?.url;
  return typeof url === "string" && url.length > 0;
}

/**
 * The agent to run for an assignee, or null when the assignee is a human member
 * (or unassigned). The Super Agent sentinel maps to the org's well-known
 * Decopilot; a code agent maps to itself. Does NOT validate — a returned null
 * only means "not a delegatable agent", not "invalid assignee".
 */
export async function resolveAssigneeAgent(
  ctx: StudioContext,
  organizationId: string,
  assigneeId: string,
): Promise<DelegatedAgent | null> {
  if (assigneeId === SUPER_AGENT_ASSIGNEE_ID) {
    return { id: getDecopilotId(organizationId), title: "Super Agent" };
  }

  const agent = await ctx.storage.virtualMcps.findById(
    assigneeId,
    organizationId,
  );
  // findById doesn't org-filter the DB path, so guard ownership before trusting
  // it — never delegate to another org's agent.
  if (
    agent &&
    agent.organization_id === organizationId &&
    agentMetadataHasClonableRepo(agent.metadata)
  ) {
    return { id: agent.id, title: agent.title };
  }
  return null;
}

/** Throws if `assigneeId` is not a member of the organization. */
async function assertOrgMember(
  ctx: StudioContext,
  organizationId: string,
  assigneeId: string,
): Promise<void> {
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

/**
 * Validate an assignee and resolve whether it delegates to an agent. Throws if
 * the assignee is neither a delegatable agent (the Super Agent or a code agent)
 * nor an org member. Returns the agent to enqueue, or null for a human member.
 */
export async function resolveValidAssignee(
  ctx: StudioContext,
  organizationId: string,
  assigneeId: string,
): Promise<DelegatedAgent | null> {
  const agent = await resolveAssigneeAgent(ctx, organizationId, assigneeId);
  if (agent) return agent;
  await assertOrgMember(ctx, organizationId, assigneeId);
  return null;
}
