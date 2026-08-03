import type { Thread } from "@/storage/types";

/**
 * User-authored routing changes are blocked after the first hosted/native
 * start claims a thread. Display fields may still change, but the thread
 * update tool cannot move persisted history to another authority context.
 * Trusted runtime code can still evolve server-owned routing state (for
 * example, Decopilot's load_repo tool binds a selected repository branch).
 */
export function assertThreadRoutingUpdateAllowed(
  thread: Pick<Thread, "harness_id" | "virtual_mcp_id" | "branch">,
  update: { virtual_mcp_id?: string; branch?: string | null },
): void {
  if (!thread.harness_id) return;

  if (
    update.virtual_mcp_id !== undefined &&
    update.virtual_mcp_id !== thread.virtual_mcp_id
  ) {
    throw new Error("Cannot change the agent after this chat has started");
  }
  if (update.branch !== undefined && update.branch !== thread.branch) {
    throw new Error("Cannot change the branch after this chat has started");
  }
}

export function changesThreadRouting(
  thread: Pick<Thread, "virtual_mcp_id" | "branch">,
  update: { virtual_mcp_id?: string; branch?: string | null },
): boolean {
  return (
    (update.virtual_mcp_id !== undefined &&
      update.virtual_mcp_id !== thread.virtual_mcp_id) ||
    (update.branch !== undefined && update.branch !== thread.branch)
  );
}
