/**
 * TasksPanelColumn — fixed-width left column hosting the org-wide TasksPanel.
 *
 * Lives outside the agent-scoped Suspense so it stays mounted across
 * virtualMcpId switches. Default open state follows the count of tasks +
 * automations; user-driven `?tasks=0|1` overrides the default.
 */

import { Suspense } from "react";
import { useTasksPanelState } from "@/web/hooks/use-tasks-panel-state";
import { TasksPanel } from "@/web/layouts/tasks-panel";

const TASKS_COLUMN_WIDTH_PX = 340;
const TASKS_COLUMN_WIDTH_WIDE_PX = 560;

function TasksPanelColumnInner({ wide }: { wide?: boolean }) {
  const { tasksOpen } = useTasksPanelState();

  if (!tasksOpen) return null;

  const widthPx = wide ? TASKS_COLUMN_WIDTH_WIDE_PX : TASKS_COLUMN_WIDTH_PX;

  return (
    <aside
      className="shrink-0 h-full bg-sidebar pb-1"
      style={{ width: `${widthPx}px` }}
    >
      <div className="h-full p-0.5 pt-0.25">
        <div className="h-full bg-background rounded-[0.75rem] overflow-hidden card-shadow">
          <TasksPanel />
        </div>
      </div>
    </aside>
  );
}

export function TasksPanelColumn({ wide }: { wide?: boolean } = {}) {
  return (
    <Suspense fallback={null}>
      <TasksPanelColumnInner wide={wide} />
    </Suspense>
  );
}
