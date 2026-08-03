import type { Thread } from "@/storage/types";

type ThreadAuthorityFailure =
  | "organization_mismatch"
  | "owner_mismatch"
  | "agent_missing"
  | "agent_mismatch";

export class ThreadAuthorityError extends Error {
  constructor(
    readonly reason: ThreadAuthorityFailure,
    message: string,
  ) {
    super(message);
    this.name = "ThreadAuthorityError";
  }
}

/**
 * Resolve the identities that authorize a hosted run from the persisted
 * thread. Request and durable-workflow payloads are snapshots, so neither is
 * allowed to choose the agent that executes a thread.
 *
 * `requestedAgentId` is used only at the HTTP boundary, where a mismatched
 * legacy field is rejected before any write. Durable callers omit it so an old
 * DBOS payload can still replay safely after the thread becomes authoritative.
 */
export function resolveThreadAuthority(
  thread: Pick<Thread, "organization_id" | "created_by" | "virtual_mcp_id">,
  expected: {
    organizationId: string;
    userId: string;
    requestedAgentId?: string;
  },
): { agentId: string } {
  if (thread.organization_id !== expected.organizationId) {
    throw new ThreadAuthorityError(
      "organization_mismatch",
      "Thread does not belong to this organization",
    );
  }
  if (thread.created_by !== expected.userId) {
    throw new ThreadAuthorityError(
      "owner_mismatch",
      "You are not allowed to write to this thread because you are not the owner",
    );
  }

  const agentId = thread.virtual_mcp_id.trim();
  if (!agentId) {
    throw new ThreadAuthorityError(
      "agent_missing",
      "Thread has no assigned agent",
    );
  }
  if (
    expected.requestedAgentId !== undefined &&
    expected.requestedAgentId !== agentId
  ) {
    throw new ThreadAuthorityError(
      "agent_mismatch",
      "Requested agent does not match this thread",
    );
  }

  return { agentId };
}
