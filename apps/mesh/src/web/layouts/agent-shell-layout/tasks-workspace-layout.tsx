/**
 * TasksWorkspaceLayout — wraps the TasksPanelColumn + main outlet in a
 * horizontal ResizablePanelGroup so the Tasks column width is user-resizable.
 *
 * When `tasksOpen` is false the Tasks panel is removed entirely (same
 * behavior as before) and only `children` is rendered, so no resize handle
 * is shown.
 */

import { useTransition, type PropsWithChildren } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/web/components/resizable";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { useTasksPanelState } from "@/web/hooks/use-tasks-panel-state";
import { TasksPanelColumnInner } from "@/web/layouts/agent-shell-layout/tasks-panel-column";

const DEFAULT_TASKS_PANEL_SIZE = 18;
const MIN_TASKS_PANEL_SIZE = 14;
const MAX_TASKS_PANEL_SIZE = 30;

export function TasksWorkspaceLayout({ children }: PropsWithChildren) {
  const { tasksOpen } = useTasksPanelState();
  const [storedTasksWidth, setTasksWidth] = useLocalStorage(
    LOCALSTORAGE_KEYS.tasksPanelWidth(),
    DEFAULT_TASKS_PANEL_SIZE,
  );
  const [_isPending, startTransition] = useTransition();

  if (!tasksOpen) {
    return <>{children}</>;
  }

  const handleResize = (size: number) =>
    startTransition(() => {
      if (size >= MIN_TASKS_PANEL_SIZE && size <= MAX_TASKS_PANEL_SIZE) {
        setTasksWidth(size);
      }
    });

  return (
    <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
      <ResizablePanel
        order={1}
        defaultSize={storedTasksWidth}
        minSize={MIN_TASKS_PANEL_SIZE}
        maxSize={MAX_TASKS_PANEL_SIZE}
        onResize={handleResize}
        className="overflow-hidden"
      >
        <TasksPanelColumnInner />
      </ResizablePanel>
      <ResizableHandle className="bg-sidebar" />
      <ResizablePanel order={2} minSize={30} className="min-w-0 flex flex-col">
        {children}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
