/**
 * Task Manager — React Query hooks for thread/task management.
 *
 * Scoped by virtualMcpId: only fetches threads for the current agent.
 * Keeps an org-wide SSE subscription for real-time sidebar status updates.
 * URL owns the active task ID — this hook no longer manages it.
 */

import type { CollectionListOutput } from "@decocms/bindings/collections";
import type { CollectionEntity } from "@decocms/mesh-sdk";
import type { ProjectLocator } from "@decocms/mesh-sdk";
import {
  SELF_MCP_ALIAS_ID,
  useCollectionList,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "../../../lib/auth-client";
import { LOCALSTORAGE_KEYS } from "../../../lib/localstorage-keys";
import { KEYS } from "../../../lib/query-keys";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import { updateMessagesCache, updateTaskInCache } from "./cache-operations.ts";
import { callUpdateTaskTool } from "./helpers.ts";
import { useState, useTransition } from "react";
import type { ChatMessage, Task } from "./types.ts";
import { TASK_CONSTANTS } from "./types.ts";

export type TaskOwnerFilter = "me" | "automation" | "all";
export type TaskStatusFilter = "open" | "archived";

export interface UseTasksParams {
  owner: TaskOwnerFilter;
  status: TaskStatusFilter;
  userId?: string;
  virtualMcpId?: string;
  hasTrigger?: boolean;
}

// ============================================================================
// useTasks — fetch task list across agents, filtered by owner/status
// ============================================================================

export function useTasks(params: UseTasksParams) {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, refetch } = useSuspenseQuery({
    queryKey: KEYS.tasks(locator, {
      owner: params.owner,
      status: params.status,
      virtualMcpId: params.virtualMcpId,
      userId: params.owner === "me" ? (params.userId ?? null) : null,
      hasTrigger: params.hasTrigger ?? null,
    }),
    queryFn: async () => {
      if (!client) {
        throw new Error("MCP client is not available");
      }
      const where: Record<string, unknown> = {
        hidden: params.status === "archived",
      };
      if (params.virtualMcpId) where.virtual_mcp_id = params.virtualMcpId;
      if (params.owner === "me") where.created_by = "me";
      if (params.owner === "automation") where.has_trigger = true;
      if (params.hasTrigger !== undefined)
        where.has_trigger = params.hasTrigger;

      const input = {
        limit: TASK_CONSTANTS.TASKS_PAGE_SIZE,
        offset: 0,
        orderBy: [{ field: ["updated_at"], direction: "desc" as const }],
        where,
      };

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
    staleTime: TASK_CONSTANTS.QUERY_STALE_TIME,
  });

  const tasks = data?.items ?? [];
  return { tasks, refetch };
}

// ============================================================================
// useTaskMessages — fetch messages for a specific task (exported for provider)
// ============================================================================

export function useTaskMessages(taskId: string | null) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  // Pass null client when no taskId to skip the query entirely
  const data = useCollectionList<CollectionEntity & ChatMessage>(
    org.id,
    "THREAD_MESSAGES",
    taskId ? client : null,
    {
      filters: taskId ? [{ column: "thread_id", value: taskId }] : [],
      pageSize: TASK_CONSTANTS.TASK_MESSAGES_PAGE_SIZE,
    },
  ) as ChatMessage[] | undefined;

  return data ?? [];
}

// ============================================================================
// useTaskManager — unified task management hook
// ============================================================================

export function useTaskManager(virtualMcpId: string) {
  const { locator, org } = useProjectContext();
  const queryClient = useQueryClient();

  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  // Owner filter (localStorage-backed). Legacy "everyone" migrated to "all".
  const readStoredFilter = (loc: ProjectLocator): TaskOwnerFilter => {
    try {
      const stored = localStorage.getItem(
        LOCALSTORAGE_KEYS.chatTaskOwnerFilter(loc),
      );
      if (!stored) return "me";
      const parsed = JSON.parse(stored);
      if (parsed === "everyone") return "all";
      if (parsed === "me" || parsed === "automation" || parsed === "all") {
        return parsed;
      }
      return "me";
    } catch {
      return "me";
    }
  };

  const [ownerFilter, rawSetOwnerFilter] = useState<TaskOwnerFilter>(() =>
    readStoredFilter(locator),
  );

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
      // ignore
    }
  };

  // Fetch tasks (scoped by virtualMcpId, open status)
  const { tasks } = useTasks({
    owner: ownerFilter,
    status: "open",
    userId,
    virtualMcpId,
  });

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  // Update task in cache (across all matching task lists)
  const updateTask = (taskId: string, updates: Partial<Task>) => {
    updateTaskInCache(queryClient, locator, taskId, updates);
  };

  // Set task status (backend + cache)
  // If the thread doesn't exist server-side (cache-only), apply the transition locally.
  const setTaskStatus = async (taskId: string, status: string) => {
    try {
      const updatedTask = await callUpdateTaskTool(client, taskId, {
        status: status as
          | "requires_action"
          | "failed"
          | "in_progress"
          | "completed",
      });
      const updates: Partial<Task> = {
        status: updatedTask?.status ?? (status as Task["status"]),
        updated_at: updatedTask?.updated_at ?? new Date().toISOString(),
      };
      updateTaskInCache(queryClient, locator, taskId, updates);
    } catch (error) {
      const err = error as Error;
      toast.error(`Failed to update task status: ${err.message}`);
      console.error("[chat] Failed to set task status:", error);
    }
  };

  // Persist the picked branch on the thread row. Server enforces that
  // github-linked threads cannot have branch=null; surface that error.
  const setTaskBranch = async (taskId: string, branch: string | null) => {
    try {
      await callUpdateTaskTool(client, taskId, { branch });
      updateTaskInCache(queryClient, locator, taskId, { branch });
    } catch (error) {
      const err = error as Error;
      toast.error(`Failed to update branch: ${err.message}`);
      console.error("[chat] setTaskBranch:", error);
    }
  };

  // Rename task (backend + cache)
  const renameTask = async (taskId: string, title: string) => {
    try {
      const updatedTask = await callUpdateTaskTool(client, taskId, { title });
      if (updatedTask) {
        updateTaskInCache(queryClient, locator, taskId, {
          title,
          updated_at: updatedTask.updated_at ?? new Date().toISOString(),
        });
      }
    } catch (error) {
      const err = error as Error;
      toast.error(`Failed to rename task: ${err.message}`);
      console.error("[chat] Failed to rename task:", error);
    }
  };

  // Hide task (backend + cache)
  // Invalidate all task lists so hidden tasks disappear from open lists
  // and (re)appear in archived lists on the next fetch.
  const hideTask = async (taskId: string) => {
    try {
      await callUpdateTaskTool(client, taskId, { hidden: true });
    } catch (error) {
      const err = error as Error;
      toast.error(`Failed to update task: ${err.message}`);
      console.error("[chat] Failed to hide task:", error);
      return;
    }
    queryClient.invalidateQueries({
      queryKey: KEYS.tasksPrefix(locator),
    });
  };

  // Update messages cache
  const updateMessagesInCache = (
    taskId: string,
    newMessages: ChatMessage[],
  ) => {
    updateMessagesCache(queryClient, client, org.id, taskId, newMessages);
  };

  // Org-wide SSE for real-time sidebar task status updates
  useDecopilotEvents({
    orgSlug: org.slug,
    enabled: true,
    onTaskStatus: (event) => {
      const threadId = event.subject;
      const newStatus = event.data.status;
      const updatedAt = event.time;

      const found = updateTaskInCache(queryClient, locator, threadId, {
        status: newStatus,
        updated_at: updatedAt,
      });

      // Task not in any cache — refetch so new tasks appear in the list
      if (!found) {
        queryClient.invalidateQueries({
          queryKey: KEYS.tasksPrefix(locator),
        });
      }
    },
  });

  return {
    tasks,
    ownerFilter,
    setOwnerFilter,
    isFilterChangePending,
    updateTask,
    renameTask,
    hideTask,
    setTaskStatus,
    setTaskBranch,
    updateMessagesCache: updateMessagesInCache,
  };
}
