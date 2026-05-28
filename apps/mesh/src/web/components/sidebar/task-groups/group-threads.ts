import type { Task } from "@/web/components/chat/task/types";
import type { StatusKey } from "@/web/lib/task-status";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";

/** Synthetic group key for threads with no virtual_mcp_id (tool-call runs etc). */
export const TOOL_CALL_RUNS_GROUP_KEY = "__tool_call_runs__";

export interface TaskGroupData {
  virtualMcpId: string;
  threads: Task[];
  /** Latest updated_at in the group (ISO). Empty string for empty groups. */
  latestUpdatedAt: string;
}

export interface StatusGroupData {
  status: StatusKey;
  threads: Task[];
}

const STATUS_GROUP_ORDER: StatusKey[] = [
  "requires_action",
  "in_progress",
  "failed",
  "expired",
  "completed",
];

export function groupThreadsByStatus(threads: Task[]): StatusGroupData[] {
  const byStatus = new Map<StatusKey, Task[]>(
    STATUS_GROUP_ORDER.map((s) => [s, []]),
  );

  for (const thread of threads) {
    const key = (thread.status ?? "completed") as StatusKey;
    (byStatus.get(key) ?? byStatus.get("completed")!).push(thread);
  }

  return STATUS_GROUP_ORDER.map((status) => ({
    status,
    threads: byStatus.get(status)!,
  })).filter((g) => g.threads.length > 0);
}

/**
 * Group threads by virtual_mcp_id, surfacing every agent from the directory.
 *
 * Ordering:
 *  - Decopilot pinned first (when provided).
 *  - Active agents (have at least one thread in `threads`) sorted by
 *    `max(updated_at)` desc.
 *  - Inactive agents (in the directory but with no thread in `threads`)
 *    rendered after, sorted alphabetically by `id`.
 *  - Threads without a `virtual_mcp_id` bucket under TOOL_CALL_RUNS_GROUP_KEY
 *    and appear last.
 *
 * Within an active group, thread order is preserved from the input (callers
 * already sort by `updated_at` desc — we don't re-sort).
 */
export function groupThreadsByVirtualMcp(
  threads: Task[],
  agents: VirtualMCPEntity[],
  decopilotVirtualMcpId: string | null,
): TaskGroupData[] {
  const byId = new Map<string, TaskGroupData>();

  // Seed every directory agent as an empty group; bucketing below may
  // populate them.
  for (const agent of agents) {
    byId.set(agent.id, {
      virtualMcpId: agent.id,
      threads: [],
      latestUpdatedAt: "",
    });
  }

  for (const thread of threads) {
    if (thread.id.startsWith("thrd_welcome_")) continue;
    const key = thread.virtual_mcp_id ?? TOOL_CALL_RUNS_GROUP_KEY;
    const existing = byId.get(key);
    if (existing) {
      existing.threads.push(thread);
      if ((thread.updated_at ?? "") > existing.latestUpdatedAt) {
        existing.latestUpdatedAt = thread.updated_at ?? "";
      }
    } else {
      byId.set(key, {
        virtualMcpId: key,
        threads: [thread],
        latestUpdatedAt: thread.updated_at ?? "",
      });
    }
  }

  if (decopilotVirtualMcpId && !byId.has(decopilotVirtualMcpId)) {
    byId.set(decopilotVirtualMcpId, {
      virtualMcpId: decopilotVirtualMcpId,
      threads: [],
      latestUpdatedAt: "",
    });
  }

  const decopilot =
    decopilotVirtualMcpId !== null
      ? byId.get(decopilotVirtualMcpId)
      : undefined;
  if (decopilot && decopilotVirtualMcpId) byId.delete(decopilotVirtualMcpId);

  const toolCallRuns = byId.get(TOOL_CALL_RUNS_GROUP_KEY);
  if (toolCallRuns) byId.delete(TOOL_CALL_RUNS_GROUP_KEY);

  const remaining = [...byId.values()];
  const active = remaining
    .filter((g) => g.threads.length > 0)
    .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
  const inactive = remaining
    .filter((g) => g.threads.length === 0)
    .sort((a, b) => a.virtualMcpId.localeCompare(b.virtualMcpId));

  const result: TaskGroupData[] = [];
  if (decopilot) result.push(decopilot);
  result.push(...active, ...inactive);
  if (toolCallRuns) result.push(toolCallRuns);
  return result;
}
