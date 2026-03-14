/**
 * Chat Store Hooks using React Query + IndexedDB
 *
 * Provides React hooks for working with tasks and messages stored in IndexedDB.
 * Uses TanStack React Query for caching and mutations with idb-keyval for persistence.
 */

import type {
  CollectionListInput,
  CollectionListOutput,
} from "@decocms/bindings/collections";
import type { CollectionEntity } from "@decocms/mesh-sdk";
import type { ProjectLocator } from "@decocms/mesh-sdk";
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
import { authClient } from "../../../lib/auth-client";
import { useCollectionCachePrefill } from "../../../hooks/use-collection-cache-prefill";
import { useLocalStorage } from "../../../hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "../../../lib/localstorage-keys";
import { KEYS } from "../../../lib/query-keys";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import {
  addTaskToCache,
  prefetchTaskMessages,
  updateMessagesCache,
  updateTaskInCache,
} from "./cache-operations.ts";
import {
  buildOptimisticTask,
  callUpdateTaskTool,
  findNextAvailableTask,
} from "./helpers.ts";
import { useState, useTransition } from "react";
import type { ChatMessage, Task, TasksInfiniteQueryData } from "./types.ts";
import { TASK_CONSTANTS } from "./types.ts";

export type TaskOwnerFilter = "me" | "everyone";

/**
 * Hook to get all tasks with infinite scroll pagination
 *
 * @param ownerFilter - "me" filters to current user's tasks, "everyone" shows all org tasks
 * @param userId - current user's ID, required when ownerFilter is "me"
 * @returns Object with tasks array, pagination helpers, and refetch function
 */
function useTasks(ownerFilter: TaskOwnerFilter, userId: string | undefined) {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useSuspenseInfiniteQuery({
      queryKey: KEYS.tasks(
        locator,
        ownerFilter,
        ownerFilter === "me" ? userId : undefined,
      ),
      queryFn: async ({ pageParam = 0 }) => {
        if (!client) {
          throw new Error("MCP client is not available");
        }
        if (ownerFilter === "me" && !userId) {
          return { items: [], hasMore: false, totalCount: 0 };
        }
        const baseInput: CollectionListInput = {
          limit: TASK_CONSTANTS.TASKS_PAGE_SIZE,
          offset: pageParam,
        };
        const input =
          ownerFilter === "me"
            ? { ...baseInput, where: { created_by: userId! } }
            : baseInput;

        const result = (await client.callTool({
          name: "COLLECTION_THREADS_LIST",
          arguments: input,
        })) as { structuredContent?: unknown };
        const payload = (result.structuredContent ??
          result) as CollectionListOutput<Task>;

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
        return allPages.length * TASK_CONSTANTS.TASKS_PAGE_SIZE;
      },
      initialPageParam: 0,
      staleTime: TASK_CONSTANTS.QUERY_STALE_TIME,
    });

  // Flatten all pages into a single tasks array
  const tasks = data?.pages.flatMap((page) => page.items) ?? [];

  return {
    tasks,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  };
}

/**
 * Hook to get messages for a specific task
 *
 * @param taskId - The ID of the task
 * @returns Suspense query result with messages array
 */
function useTaskMessages(taskId: string | null) {
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
      filters: taskId ? [{ column: "thread_id", value: taskId }] : [],
      pageSize: TASK_CONSTANTS.TASK_MESSAGES_PAGE_SIZE,
    },
  ) as ChatMessage[] | undefined;

  return data ?? [];
}

/**
 * Unified hook that manages all task state and operations
 * Encapsulates task fetching, message fetching, active task management, and all task actions
 *
 * @returns Object with task state, pagination info, and action methods
 */
export function useTaskManager() {
  const { locator, org } = useProjectContext();
  const queryClient = useQueryClient();
  const { prefillCollectionCache } = useCollectionCachePrefill();

  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const readStoredFilter = (loc: ProjectLocator): TaskOwnerFilter => {
    try {
      const stored = localStorage.getItem(
        LOCALSTORAGE_KEYS.chatTaskOwnerFilter(loc),
      );
      return stored ? (JSON.parse(stored) as TaskOwnerFilter) : "me";
    } catch {
      return "me";
    }
  };

  const [ownerFilter, rawSetOwnerFilter] = useState<TaskOwnerFilter>(() =>
    readStoredFilter(locator),
  );

  // When locator changes (project/org switch), re-read the persisted filter
  // for the new context. Calling setState during render causes React to discard
  // the in-progress render and immediately re-render with the corrected value.
  const [prevLocator, setPrevLocator] = useState(locator);
  if (prevLocator !== locator) {
    setPrevLocator(locator);
    rawSetOwnerFilter(readStoredFilter(locator));
  }

  const [isFilterChangePending, startFilterTransition] = useTransition();

  const setOwnerFilter = (filter: TaskOwnerFilter) => {
    startFilterTransition(() => rawSetOwnerFilter(filter));
    try {
      localStorage.setItem(
        LOCALSTORAGE_KEYS.chatTaskOwnerFilter(locator),
        JSON.stringify(filter),
      );
    } catch {
      // ignore storage errors
    }
  };

  // Fetch tasks list with pagination
  const { tasks, hasNextPage, isFetchingNextPage, fetchNextPage } = useTasks(
    ownerFilter,
    userId,
  );

  // Initialize MCP client internally
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Manage active task ID with localStorage persistence
  const [activeTaskId, setActiveTaskId] = useLocalStorage<string>(
    LOCALSTORAGE_KEYS.assistantChatActiveTask(locator),
    tasks[0]?.id ?? crypto.randomUUID(),
  );

  // Fetch messages for the active task
  const messages = useTaskMessages(activeTaskId);

  /**
   * Create a new task
   * Generates a new task ID, optimistically adds it to cache, prefills message cache, and switches to it
   */
  const createTask = (): string => {
    const newTaskId = crypto.randomUUID();
    const optimisticTask = buildOptimisticTask(newTaskId);

    // Add task optimistically to cache so it appears immediately
    addTaskToCache(
      queryClient,
      locator,
      optimisticTask,
      ownerFilter,
      ownerFilter === "me" ? userId : undefined,
    );

    // Prefill message cache
    if (client) {
      prefillCollectionCache(client, "THREAD_MESSAGES", org.id, {
        filters: [{ column: "thread_id", value: newTaskId }],
        pageSize: TASK_CONSTANTS.TASK_MESSAGES_PAGE_SIZE,
      });
    }

    // Switch to the new task
    setActiveTaskId(newTaskId);
    return newTaskId;
  };

  /**
   * Switch to a task
   * Prefetches messages if needed to prevent suspension, then updates active task ID
   */
  const switchToTask = async (taskId: string) => {
    await prefetchTaskMessages(queryClient, client, org.id, taskId);
    setActiveTaskId(taskId);
  };

  /**
   * Update a task in the cache
   * Updates task data directly in React Query cache without refetching
   */
  const updateTask = (taskId: string, updates: Partial<Task>) => {
    updateTaskInCache(
      queryClient,
      locator,
      taskId,
      updates,
      ownerFilter,
      ownerFilter === "me" ? userId : undefined,
    );
  };

  /**
   * Rename a task
   * Calls backend to update task title, then updates cache
   */
  const renameTask = async (taskId: string, title: string) => {
    try {
      const updatedTask = await callUpdateTaskTool(client, taskId, {
        title,
      });
      if (updatedTask) {
        updateTaskInCache(
          queryClient,
          locator,
          taskId,
          {
            title,
            updated_at: updatedTask.updated_at ?? new Date().toISOString(),
          },
          ownerFilter,
          ownerFilter === "me" ? userId : undefined,
        );
      }
    } catch (error) {
      const err = error as Error;
      toast.error(`Failed to rename task: ${err.message}`);
      console.error("[chat] Failed to rename task:", error);
    }
  };

  /**
   * Hide a task
   * Calls backend to hide task, switches away if it's the current task, and updates cache
   */
  const hideTask = async (taskId: string) => {
    try {
      const updatedTask = await callUpdateTaskTool(client, taskId, {
        hidden: true,
      });
      if (updatedTask) {
        const willHideCurrentTask = taskId === activeTaskId;
        if (willHideCurrentTask) {
          // Find a different task to switch to
          const nextTask = findNextAvailableTask(tasks, taskId);
          if (nextTask) {
            // Switch to existing task with cache prefilling
            await switchToTask(nextTask.id);
          } else {
            // Create new task if no other tasks exist
            createTask();
          }
        }
        // Update task hidden status in cache
        updateTaskInCache(
          queryClient,
          locator,
          taskId,
          {
            hidden: true,
            updated_at: updatedTask.updated_at ?? new Date().toISOString(),
          },
          ownerFilter,
          ownerFilter === "me" ? userId : undefined,
        );
      }
    } catch (error) {
      const err = error as Error;
      toast.error(`Failed to update task: ${err.message}`);
      console.error("[chat] Failed to update task:", error);
    }
  };

  /**
   * Update messages cache for a task with new messages
   * Populates the cache directly without refetching from backend
   */
  const updateMessagesInCache = (
    taskId: string,
    newMessages: ChatMessage[],
  ) => {
    updateMessagesCache(queryClient, client, org.id, taskId, newMessages);
  };

  // Subscribe to org-wide SSE events so the task list stays real-time.
  // No taskId filter — we want status changes for ALL threads in the org.
  useDecopilotEvents({
    orgId: org.id,
    enabled: true,
    onTaskStatus: (event) => {
      const threadId = event.subject;
      const newStatus = event.data.status;
      const updatedAt = event.time;

      for (const filter of ["me", "everyone"] as const) {
        const filterUserId = filter === "me" ? userId : undefined;
        const cached = queryClient.getQueryData<TasksInfiniteQueryData>(
          KEYS.tasks(locator, filter, filterUserId),
        );
        const inCache =
          cached?.pages.some((p) => p.items.some((t) => t.id === threadId)) ??
          false;

        if (inCache) {
          updateTaskInCache(
            queryClient,
            locator,
            threadId,
            { status: newStatus, updated_at: updatedAt },
            filter,
            filterUserId,
          );
        } else if (filter === "everyone") {
          // Task not yet in the "everyone" cache — could be a new task from
          // another user. Mark as stale so the next render triggers a refetch.
          queryClient.invalidateQueries({
            queryKey: KEYS.tasks(locator, "everyone"),
          });
        }
      }
    },
  });

  return {
    tasks,
    activeTaskId,
    setActiveTaskId,
    messages,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    ownerFilter,
    setOwnerFilter,
    isFilterChangePending,
    createTask,
    switchToTask,
    updateTask,
    renameTask,
    hideTask,
    updateMessagesCache: updateMessagesInCache,
  };
}
