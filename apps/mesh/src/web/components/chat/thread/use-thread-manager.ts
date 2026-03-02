/**
 * Chat Store Hooks using React Query + IndexedDB
 *
 * Provides React hooks for working with threads and messages stored in IndexedDB.
 * Uses TanStack React Query for caching and mutations with idb-keyval for persistence.
 */

import type {
  CollectionListInput,
  CollectionListOutput,
} from "@decocms/bindings/collections";
import type { CollectionEntity } from "@decocms/mesh-sdk";
import {
  SELF_MCP_ALIAS_ID,
  useCollectionList,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  useQueryClient,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useCollectionCachePrefill } from "../../../hooks/use-collection-cache-prefill";
import { useLocalStorage } from "../../../hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "../../../lib/localstorage-keys";
import { KEYS } from "../../../lib/query-keys";
import {
  addThreadToCache,
  prefetchThreadMessages,
  updateMessagesCache,
  updateThreadInCache,
} from "./cache-operations.ts";
import {
  buildOptimisticThread,
  callUpdateThreadTool,
  findNextAvailableThread,
} from "./helpers.ts";
import type { ChatMessage, Thread } from "./types.ts";
import { THREAD_CONSTANTS } from "./types.ts";

/**
 * Hook to get all threads with infinite scroll pagination
 *
 * @returns Object with threads array, pagination helpers, and refetch function
 */
function useThreads() {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useSuspenseInfiniteQuery({
      queryKey: KEYS.threads(locator),
      queryFn: async ({ pageParam = 0 }) => {
        if (!client) {
          throw new Error("MCP client is not available");
        }
        const input: CollectionListInput = {
          limit: THREAD_CONSTANTS.THREADS_PAGE_SIZE,
          offset: pageParam,
        };

        const result = (await client.callTool({
          name: "COLLECTION_THREADS_LIST",
          arguments: input,
        })) as { structuredContent?: unknown };
        const payload = (result.structuredContent ??
          result) as CollectionListOutput<Thread>;

        return {
          items: payload.items ?? [],
          hasMore: payload.hasMore ?? false,
          totalCount: payload.totalCount,
        };
      },
      getNextPageParam: (lastPage, allPages) => {
        if (!lastPage.hasMore) {
          return undefined;
        }
        return allPages.length * THREAD_CONSTANTS.THREADS_PAGE_SIZE;
      },
      initialPageParam: 0,
      staleTime: THREAD_CONSTANTS.QUERY_STALE_TIME,
    });

  // Flatten all pages into a single threads array
  const threads = data?.pages.flatMap((page) => page.items) ?? [];

  return {
    threads,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  };
}

/**
 * Hook to get messages for a specific thread
 *
 * @param threadId - The ID of the thread
 * @returns Suspense query result with messages array
 */
function useThreadMessages(threadId: string | null) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Use type assertion since ThreadMessageEntity doesn't extend CollectionEntity
  // but the runtime behavior works correctly
  const data = useCollectionList<CollectionEntity & ChatMessage>(
    org.id,
    "THREAD_MESSAGES",
    client,
    {
      filters: threadId ? [{ column: "thread_id", value: threadId }] : [],
      pageSize: THREAD_CONSTANTS.THREAD_MESSAGES_PAGE_SIZE,
    },
  ) as ChatMessage[] | undefined;

  return data ?? [];
}

/**
 * Unified hook that manages all thread state and operations
 * Encapsulates thread fetching, message fetching, active thread management, and all thread actions
 *
 * @returns Object with thread state, pagination info, and action methods
 */
export function useThreadManager() {
  const { locator, org } = useProjectContext();
  const queryClient = useQueryClient();
  const { prefillCollectionCache } = useCollectionCachePrefill();

  // Fetch threads list with pagination
  const { threads, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useThreads();

  // Initialize MCP client internally
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Manage active thread ID with localStorage persistence
  const [activeThreadId, setActiveThreadId] = useLocalStorage<string>(
    LOCALSTORAGE_KEYS.assistantChatActiveThread(locator),
    threads[0]?.id ?? crypto.randomUUID(),
  );

  // Fetch messages for the active thread
  const messages = useThreadMessages(activeThreadId);

  /**
   * Create a new thread
   * Generates a new thread ID, optimistically adds it to cache, prefills message cache, and switches to it
   */
  const createThread = () => {
    const newThreadId = crypto.randomUUID();
    const optimisticThread = buildOptimisticThread(newThreadId);

    // Add thread optimistically to cache so it appears immediately
    addThreadToCache(queryClient, locator, optimisticThread);

    // Prefill message cache
    if (client) {
      prefillCollectionCache(client, "THREAD_MESSAGES", org.id, {
        filters: [{ column: "thread_id", value: newThreadId }],
        pageSize: THREAD_CONSTANTS.THREAD_MESSAGES_PAGE_SIZE,
      });
    }

    // Switch to the new thread
    setActiveThreadId(newThreadId);
  };

  /**
   * Switch to a thread
   * Prefetches messages if needed to prevent suspension, then updates active thread ID
   */
  const switchThread = async (threadId: string) => {
    await prefetchThreadMessages(queryClient, client, org.id, threadId);
    setActiveThreadId(threadId);
  };

  /**
   * Update a thread in the cache
   * Updates thread data directly in React Query cache without refetching
   */
  const updateThread = (threadId: string, updates: Partial<Thread>) => {
    updateThreadInCache(queryClient, locator, threadId, updates);
  };

  /**
   * Rename a thread
   * Calls backend to update thread title, then updates cache
   */
  const renameThread = async (threadId: string, title: string) => {
    try {
      const updatedThread = await callUpdateThreadTool(client, threadId, {
        title,
      });
      if (updatedThread) {
        updateThreadInCache(queryClient, locator, threadId, {
          title,
          updated_at: updatedThread.updated_at ?? new Date().toISOString(),
        });
      }
    } catch (error) {
      const err = error as Error;
      toast.error(`Failed to rename thread: ${err.message}`);
      console.error("[chat] Failed to rename thread:", error);
    }
  };

  /**
   * Hide a thread
   * Calls backend to hide thread, switches away if it's the current thread, and updates cache
   */
  const hideThread = async (threadId: string) => {
    try {
      const updatedThread = await callUpdateThreadTool(client, threadId, {
        hidden: true,
      });
      if (updatedThread) {
        const willHideCurrentThread = threadId === activeThreadId;
        if (willHideCurrentThread) {
          // Find a different thread to switch to
          const nextThread = findNextAvailableThread(threads, threadId);
          if (nextThread) {
            // Switch to existing thread with cache prefilling
            await switchThread(nextThread.id);
          } else {
            // Create new thread if no other threads exist
            createThread();
          }
        }
        // Update thread hidden status in cache
        updateThreadInCache(queryClient, locator, threadId, {
          hidden: true,
          updated_at: updatedThread.updated_at ?? new Date().toISOString(),
        });
      }
    } catch (error) {
      const err = error as Error;
      toast.error(`Failed to update thread: ${err.message}`);
      console.error("[chat] Failed to update thread:", error);
    }
  };

  /**
   * Update messages cache for a thread with new messages
   * Populates the cache directly without refetching from backend
   */
  const updateMessagesInCache = (
    threadId: string,
    newMessages: ChatMessage[],
  ) => {
    updateMessagesCache(queryClient, client, org.id, threadId, newMessages);
  };

  return {
    // State
    threads,
    activeThreadId,
    messages,

    // Pagination
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,

    // Actions
    createThread,
    switchThread,
    updateThread,
    renameThread,
    hideThread,
    updateMessagesCache: updateMessagesInCache,
  };
}
