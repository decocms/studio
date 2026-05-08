import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTasks } from "@/web/components/chat/task/use-task-manager";
import { resolveTasksOpen } from "@/web/hooks/use-layout-state";

interface TasksPanelState {
  tasksOpen: boolean;
  toggleTasks: () => void;
}

const TasksPanelStateContext = createContext<TasksPanelState | null>(null);

/**
 * Provider for the tasks-panel open/closed state.
 *
 * Flow:
 *   url → state   (init only, when the provider first mounts)
 *   state → url   (on every change, via effect)
 *
 * URL model: `?tasks=0|1`. When absent on first mount the panel defaults
 * to open iff there are open tasks. The URL is always kept in sync so a
 * refresh restores the last state the user chose.
 */
export function TasksPanelStateProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tasks?: number };
  const { tasks } = useTasks({ owner: "all", status: "open" });

  const [tasksOpen, setTasksOpen] = useState<boolean>(() =>
    resolveTasksOpen(search.tasks, tasks.length > 0),
  );

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    navigate({
      // biome-ignore lint/suspicious/noExplicitAny: tanstack router search-reducer signature
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        tasks: tasksOpen ? 1 : 0,
      })) as any,
      replace: true,
    });
  }, [tasksOpen, navigate]);

  const toggleTasks = () => setTasksOpen((prev) => !prev);

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
