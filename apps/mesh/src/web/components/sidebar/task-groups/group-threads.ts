import type { Task } from "@/web/components/chat/task/types";
import type { StatusKey } from "@/web/lib/task-status";

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
 * Group threads by virtual_mcp_id with Decopilot pinned first.
 *
 * - `decopilotVirtualMcpId` is always present as the first entry (with an empty
 *   `threads` array if none of the input threads target it). Pass `null` to skip.
 * - Other groups are ordered by `max(updated_at)` desc.
 * - Threads with no `virtual_mcp_id` (tool-call runs) bucket under
 *   `TOOL_CALL_RUNS_GROUP_KEY` and appear last.
 * - Within a group, thread order is preserved from the input (callers already
 *   sort by `updated_at` desc — we don't re-sort).
 */
export function groupThreadsByVirtualMcp(
  threads: Task[],
  decopilotVirtualMcpId: string | null,
): TaskGroupData[] {
  const byId = new Map<string, TaskGroupData>();

  for (const thread of threads) {
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

  const middle = [...byId.values()].sort((a, b) =>
    b.latestUpdatedAt.localeCompare(a.latestUpdatedAt),
  );

  const result: TaskGroupData[] = [];
  if (decopilot) result.push(decopilot);
  result.push(...middle);
  if (toolCallRuns) result.push(toolCallRuns);
  return result;
}
