import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useThreads } from "@/web/components/chat/task";
import { resolveTasksOpen } from "@/web/hooks/use-layout-state";

interface TasksPanelState {
  tasksOpen: boolean;
  toggleTasks: () => void;
}

const TasksPanelStateContext = createContext<TasksPanelState | null>(null);

/**
 * Provider for the tasks-panel open/closed state.
 *
 * The URL is the single source of truth: `?tasks=0|1`. When the param is
 * absent the panel defaults to open iff we are on a task route with open
 * threads — see `resolveTasksOpen`. `toggleTasks` writes the flipped value
 * back into the URL search; consumers re-render off the URL.
 */
export function TasksPanelStateProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tasks?: number };
  const params = useParams({ strict: false }) as { taskId?: string };
  const { threads } = useThreads("org", "open");

  const tasksOpen = resolveTasksOpen(
    search.tasks,
    Boolean(params.taskId) && threads.length > 0,
  );

  const toggleTasks = () =>
    navigate({
      // biome-ignore lint/suspicious/noExplicitAny: tanstack router search-reducer signature
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        tasks: tasksOpen ? 0 : 1,
      })) as any,
      replace: true,
    });

  return (
    <TasksPanelStateContext.Provider value={{ tasksOpen, toggleTasks }}>
      {children}
    </TasksPanelStateContext.Provider>
  );
}

export function useTasksPanelState(): TasksPanelState {
  const ctx = useContext(TasksPanelStateContext);
  if (!ctx) {
    throw new Error(
      "useTasksPanelState must be used inside <TasksPanelStateProvider>",
    );
  }
  return ctx;
}

export function useOptionalTasksPanelState(): TasksPanelState | null {
  return useContext(TasksPanelStateContext);
}
