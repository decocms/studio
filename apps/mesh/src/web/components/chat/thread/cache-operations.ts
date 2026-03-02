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
import type { ChatMessage, Thread, ThreadsInfiniteQueryData } from "./types.ts";
import { THREAD_CONSTANTS } from "./types.ts";

/**
 * Update thread in React Query cache
 */
export function updateThreadInCache(
  queryClient: QueryClient,
  locator: string,
  threadId: string,
  updates: Partial<Thread>,
): void {
  const queryKey = KEYS.threads(locator);

  const currentData =
    queryClient.getQueryData<ThreadsInfiniteQueryData>(queryKey);

  if (!currentData) {
    return;
  }

  const updatedPages = currentData.pages.map((page) => {
    const threadIndex = page.items.findIndex(
      (thread) => thread.id === threadId,
    );

    if (threadIndex === -1) {
      return page;
    }

    const updatedItems = [...page.items];
    const currentThread = updatedItems[threadIndex];

    if (!currentThread) {
      return page;
    }

    const updatedThread: Thread = {
      id: currentThread.id,
      title: updates.title ?? currentThread.title,
      description: updates.description ?? currentThread.description,
      created_at: currentThread.created_at,
      updated_at: updates.updated_at ?? currentThread.updated_at,
      hidden: updates.hidden ?? currentThread.hidden,
      status: updates.status ?? currentThread.status,
    };
    updatedItems[threadIndex] = updatedThread;

    return {
      ...page,
      items: updatedItems,
    };
  });

  const wasUpdated = updatedPages.some((page, pageIndex) => {
    return (
      page.items.length !== currentData.pages[pageIndex]?.items.length ||
      page.items.some(
        (thread, index) =>
          thread.id === threadId &&
          thread !== currentData.pages[pageIndex]?.items[index],
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
 * Add thread optimistically to the cache
 */
export function addThreadToCache(
  queryClient: QueryClient,
  locator: string,
  thread: Thread,
): void {
  const queryKey = KEYS.threads(locator);

  const currentData =
    queryClient.getQueryData<ThreadsInfiniteQueryData>(queryKey);

  if (!currentData) {
    // No cache exists yet, create initial structure
    queryClient.setQueryData(queryKey, {
      pages: [
        {
          items: [thread],
          hasMore: false,
          totalCount: 1,
        },
      ],
      pageParams: [0],
    });
    return;
  }

  // Check if thread already exists in cache
  const threadExists = currentData.pages.some((page) =>
    page.items.some((t) => t.id === thread.id),
  );
  if (threadExists) {
    return;
  }

  // Add thread to the first page (most recent threads)
  const firstPage = currentData.pages[0];
  if (firstPage) {
    const updatedFirstPage = {
      ...firstPage,
      items: [thread, ...firstPage.items],
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
          items: [thread],
          hasMore: false,
          totalCount: 1,
        },
      ],
    });
  }
}

/**
 * Prefetch messages for a thread
 */
export async function prefetchThreadMessages(
  queryClient: QueryClient,
  client: Client | null,
  orgId: string,
  threadId: string,
): Promise<void> {
  if (!client) {
    return;
  }

  const queryKey = buildCollectionQueryKey(client, "THREAD_MESSAGES", orgId, {
    filters: [{ column: "thread_id", value: threadId }],
    pageSize: THREAD_CONSTANTS.THREAD_MESSAGES_PAGE_SIZE,
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
    [{ column: "thread_id", value: threadId }],
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
    limit: THREAD_CONSTANTS.THREAD_MESSAGES_PAGE_SIZE,
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
    staleTime: THREAD_CONSTANTS.QUERY_STALE_TIME,
    retry: false,
  });
}

/**
 * Update messages cache for a thread with new messages
 * Populates the cache directly without refetching from backend
 */
export function updateMessagesCache(
  queryClient: QueryClient,
  client: Client | null,
  orgId: string,
  threadId: string,
  messages: ChatMessage[],
): void {
  if (!client) {
    return;
  }

  const queryKey = buildCollectionQueryKey(client, "THREAD_MESSAGES", orgId, {
    filters: [{ column: "thread_id", value: threadId }],
    pageSize: THREAD_CONSTANTS.THREAD_MESSAGES_PAGE_SIZE,
  });

  if (!queryKey) {
    return;
  }

  // Update cache with new messages in the format expected by useCollectionList
  // This matches the structure returned by the MCP tool (before select transformation)
  // Use type assertion similar to useThreadMessages since runtime structure works correctly
  queryClient.setQueryData(queryKey, {
    structuredContent: {
      items: messages as (CollectionEntity & ChatMessage)[],
    } satisfies CollectionListOutput<CollectionEntity & ChatMessage>,
    isError: false,
  });
}
