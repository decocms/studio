import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTasks } from "@/web/components/chat/task/use-task-manager";
import { resolveTasksOpen } from "@/web/hooks/use-layout-state";

interface TasksPanelState {
  tasksOpen: boolean;
  toggleTasks: () => void;
}

const TasksPanelStateContext = createContext<TasksPanelState | null>(null);

/**
 * Provider for the tasks-panel open/closed state — per-route. Closing the
 * panel inside a chat shouldn't follow you to home and vice versa, so we
 * keep one state for the home route and one for any chat route. URL
 * `?tasks=0|1` mirrors the current route's state so a refresh restores
 * what you saw.
 */
export function TasksPanelStateProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tasks?: number };
  const params = useParams({ strict: false }) as { taskId?: string };
  const { tasks } = useTasks({ owner: "all", status: "open" });
  const onHome = !params.taskId;

  // Home defaults open (preset cards are useful from a cold start). Chat
  // defaults open iff the user has tasks to read. URL ?tasks=0|1 wins on
  // first mount so refresh-after-close stays closed.
  const [homeOpen, setHomeOpen] = useState<boolean>(() =>
    onHome ? resolveTasksOpen(search.tasks, true) : true,
  );
  const [chatOpen, setChatOpen] = useState<boolean>(() =>
    !onHome
      ? resolveTasksOpen(search.tasks, tasks.length > 0)
      : tasks.length > 0,
  );

  const tasksOpen = onHome ? homeOpen : chatOpen;

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

  const toggleTasks = () => {
    if (onHome) setHomeOpen((p) => !p);
    else setChatOpen((p) => !p);
  };

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
