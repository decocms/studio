import type { ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { useThreads } from "@/web/components/chat/store/hooks";
import { filterThreads } from "@/web/components/chat/task";
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
 * `?tasks=0|1` seeds the initial value on first mount.
 */
export function TasksPanelStateProvider({ children }: { children: ReactNode }) {
  const search = useSearch({ strict: false }) as { tasks?: number };
  const params = useParams({ strict: false }) as { taskId?: string };
  const { threads: allThreads } = useThreads();
  const threads = filterThreads(allThreads, { hidden: false });
  const onHome = !params.taskId;
  const hasChats = threads.length > 0;

  const [homeOpen, setHomeOpen] = useState<boolean>(() =>
    onHome ? resolveTasksOpen(search.tasks, true) : true,
  );
  const [chatOpen, setChatOpen] = useState<boolean>(() =>
    !onHome ? resolveTasksOpen(search.tasks, hasChats) : hasChats,
  );

  const tasksOpen = onHome ? homeOpen : chatOpen;

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
