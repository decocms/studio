import type {
  CollectionListInput,
  CollectionListOutput,
} from "@decocms/bindings/collections";
import type { CollectionEntity } from "@decocms/mesh-sdk";
import {
  buildCollectionQueryKey,
  buildOrderByExpression,
  buildWhereExpression,
} from "@decocms/mesh-sdk";
import type { QueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { KEYS } from "../../../lib/query-keys";
import type { ChatMessage, Task, TasksInfiniteQueryData } from "./types.ts";
import { TASK_CONSTANTS } from "./types.ts";

/**
 * Update task in React Query cache
 */
export function updateTaskInCache(
  queryClient: QueryClient,
  locator: string,
  taskId: string,
  updates: Partial<Task>,
): void {
  const queryKey = KEYS.tasks(locator);

  const currentData =
    queryClient.getQueryData<TasksInfiniteQueryData>(queryKey);

  if (!currentData) {
    return;
  }

  const updatedPages = currentData.pages.map((page) => {
    const taskIndex = page.items.findIndex((task) => task.id === taskId);

    if (taskIndex === -1) {
      return page;
    }

    const updatedItems = [...page.items];
    const currentTask = updatedItems[taskIndex];

    if (!currentTask) {
      return page;
    }

    const updatedTask: Task = {
      id: currentTask.id,
      title: updates.title ?? currentTask.title,
      created_at: currentTask.created_at,
      updated_at: updates.updated_at ?? currentTask.updated_at,
      hidden: updates.hidden ?? currentTask.hidden,
      created_by: currentTask.created_by,
      status: updates.status ?? currentTask.status,
      is_shared: currentTask.is_shared,
    };
    updatedItems[taskIndex] = updatedTask;

    return {
      ...page,
      items: updatedItems,
    };
  });

  const wasUpdated = updatedPages.some((page, pageIndex) => {
    return (
      page.items.length !== currentData.pages[pageIndex]?.items.length ||
      page.items.some(
        (task, index) =>
          task.id === taskId &&
          task !== currentData.pages[pageIndex]?.items[index],
      )
    );
  });

  if (wasUpdated) {
    queryClient.setQueryData(queryKey, {
      ...currentData,
      pages: updatedPages,
    });
  }
}

/**
 * Add task optimistically to the cache
 */
export function addTaskToCache(
  queryClient: QueryClient,
  locator: string,
  task: Task,
): void {
  const queryKey = KEYS.tasks(locator);

  const currentData =
    queryClient.getQueryData<TasksInfiniteQueryData>(queryKey);

  if (!currentData) {
    // No cache exists yet, create initial structure
    queryClient.setQueryData(queryKey, {
      pages: [
        {
          items: [task],
          hasMore: false,
          totalCount: 1,
        },
      ],
      pageParams: [0],
    });
    return;
  }

  // Check if task already exists in cache
  const taskExists = currentData.pages.some((page) =>
    page.items.some((t) => t.id === task.id),
  );
  if (taskExists) {
    return;
  }

  // Add task to the first page (most recent tasks)
  const firstPage = currentData.pages[0];
  if (firstPage) {
    const updatedFirstPage = {
      ...firstPage,
      items: [task, ...firstPage.items],
      totalCount: (firstPage.totalCount ?? firstPage.items.length) + 1,
    };

    queryClient.setQueryData(queryKey, {
      ...currentData,
      pages: [updatedFirstPage, ...currentData.pages.slice(1)],
    });
  } else {
    // No pages exist, create first page
    queryClient.setQueryData(queryKey, {
      ...currentData,
      pages: [
        {
          items: [task],
          hasMore: false,
          totalCount: 1,
        },
      ],
    });
  }
}

/**
 * Prefetch messages for a task
 */
export async function prefetchTaskMessages(
  queryClient: QueryClient,
  client: Client | null,
  orgId: string,
  taskId: string,
): Promise<void> {
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

  // Check if data already exists in cache
  const existingData = queryClient.getQueryData(queryKey);
  if (existingData) {
    return;
  }

  // Fetch messages and populate cache (matches useCollectionList queryFn)
  const listToolName = "COLLECTION_THREAD_MESSAGES_LIST";
  const where = buildWhereExpression(
    undefined,
    [{ column: "thread_id", value: taskId }],
    [],
  );
  const orderBy = buildOrderByExpression(
    undefined,
    undefined,
    "updated_at" as keyof (CollectionEntity & ChatMessage),
  );

  const toolArguments: CollectionListInput = {
    ...(where && { where }),
    ...(orderBy && { orderBy }),
    limit: TASK_CONSTANTS.TASK_MESSAGES_PAGE_SIZE,
    offset: 0,
  };

  await queryClient.fetchQuery({
    queryKey,
    queryFn: async () => {
      const result = await client.callTool({
        name: listToolName,
        arguments: toolArguments,
      });
      return result;
    },
    staleTime: TASK_CONSTANTS.QUERY_STALE_TIME,
    retry: false,
  });
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
