/**
 * Task Manager — thin facade over the consolidated thread module.
 *
 * Kept as a separate hook so chat-context.tsx and other call sites don't
 * have to learn the new API in the same PR. New code should call
 * useThreads + useThreadActions directly and not import from here.
 */
import { useProjectContext, type ProjectLocator } from "@decocms/mesh-sdk";
import { useState, useTransition } from "react";
import { authClient } from "../../../lib/auth-client";
import { LOCALSTORAGE_KEYS } from "../../../lib/localstorage-keys";
import { filterThreads } from "./thread-filter";
import { useThreadActions } from "./thread-actions";
import { useThreads } from "./thread-store";
import type { Task } from "./types";

export type TaskOwnerFilter = "me" | "automation" | "all";
type TaskStatusFilter = "open" | "archived";

interface UseTasksParams {
  owner: TaskOwnerFilter;
  status: TaskStatusFilter;
  userId?: string;
  virtualMcpId?: string;
  hasTrigger?: boolean;
}

function useTasks(params: UseTasksParams): {
  tasks: Task[];
  refetch: () => Promise<unknown>;
} {
  const scope = params.virtualMcpId
    ? ({ kind: "agent", virtualMcpId: params.virtualMcpId } as const)
    : "org";
  const { threads, refetch } = useThreads(scope, params.status);
  const tasks = filterThreads(threads, {
    ownerUserId: params.owner === "me" ? params.userId : undefined,
    hasTrigger:
      params.hasTrigger ?? (params.owner === "automation" ? true : undefined),
  });
  return { tasks, refetch };
}

export function useTaskManager(virtualMcpId: string) {
  const { locator } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

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

  const { tasks } = useTasks({
    owner: ownerFilter,
    status: "open",
    userId,
    virtualMcpId,
  });

  const actions = useThreadActions();

  return {
    tasks,
    ownerFilter,
    setOwnerFilter,
    isFilterChangePending,
    updateTask: (taskId: string, _updates: Partial<Task>) => {
      // Optimistic patching now lives inside useThreadActions; this helper
      // exists for callers that still want to push UI-only edits before a
      // network round-trip. Use the typed setters below for new code.
      console.warn(
        "[threads] updateTask is deprecated; use renameThread/hideThread/setStatus/setBranch",
        { taskId },
      );
    },
    renameTask: actions.renameThread,
    hideTask: actions.hideThread,
    setTaskStatus: (taskId: string, status: string) =>
      actions.setStatus(taskId, status as Task["status"]),
    setTaskBranch: actions.setBranch,
    updateMessagesCache: actions.updateMessages,
  };
}

export { useTaskMessages } from "./use-task-messages";
