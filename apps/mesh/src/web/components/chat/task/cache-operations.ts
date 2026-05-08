import type { CollectionListOutput } from "@decocms/bindings/collections";
import type { CollectionEntity } from "@decocms/mesh-sdk";
import { buildCollectionQueryKey } from "@decocms/mesh-sdk";
import type { QueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { KEYS } from "../../../lib/query-keys";
import type { ChatMessage, Task, TasksQueryData } from "./types.ts";
import { TASK_CONSTANTS } from "./types.ts";

/**
 * Update task across every cached task list where it appears.
 * Returns true if the task was found (and updated) in any cache entry.
 */
export function updateTaskInCache(
  queryClient: QueryClient,
  locator: string,
  taskId: string,
  updates: Partial<Task>,
): boolean {
  let found = false;
  queryClient.setQueriesData<TasksQueryData>(
    { queryKey: KEYS.tasksPrefix(locator) },
    (data) => {
      if (!data) return data;
      const idx = data.items.findIndex((t) => t.id === taskId);
      if (idx === -1) return data;

      const current = data.items[idx];
      if (!current) return data;

      const next: Task = {
        ...current,
        title: updates.title ?? current.title,
        updated_at: updates.updated_at ?? current.updated_at,
        hidden: updates.hidden ?? current.hidden,
        status: updates.status ?? current.status,
        branch: "branch" in updates ? updates.branch : current.branch,
      };

      const items = [...data.items];
      items[idx] = next;
      found = true;
      return { ...data, items };
    },
  );
  return found;
}

/**
 * Update messages cache for a task with new messages
 * Populates the cache directly without refetching from backend
 */
export function updateMessagesCache(
  queryClient: QueryClient,
  client: Client | null,
  orgId: string,
  taskId: string,
  messages: ChatMessage[],
): void {
  if (!client) {
    return;
  }

  const queryKey = buildCollectionQueryKey(client, "THREAD_MESSAGES", orgId, {
    filters: [{ column: "thread_id", value: taskId }],
    pageSize: TASK_CONSTANTS.TASK_MESSAGES_PAGE_SIZE,
  });

  if (!queryKey) {
    return;
  }

  // Update cache with new messages in the format expected by useCollectionList
  // This matches the structure returned by the MCP tool (before select transformation)
  // Use type assertion similar to useTaskMessages since runtime structure works correctly
  queryClient.setQueryData(queryKey, {
    structuredContent: {
      items: messages as (CollectionEntity & ChatMessage)[],
    } satisfies CollectionListOutput<CollectionEntity & ChatMessage>,
    isError: false,
  });
}
