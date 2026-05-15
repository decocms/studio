import type { CollectionListOutput } from "@decocms/bindings/collections";
import type { CollectionEntity } from "@decocms/mesh-sdk";
import { buildCollectionQueryKey } from "@decocms/mesh-sdk";
import type { QueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ChatMessage } from "./types.ts";
import { TASK_CONSTANTS } from "./types.ts";

/**
 * Update messages cache for a task with new messages.
 * Populates the cache directly without refetching from backend.
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
