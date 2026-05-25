/**
 * TasksPanelColumn — left column hosting the org-wide TasksPanel.
 *
 * Lives outside the agent-scoped Suspense so it stays mounted across
 * virtualMcpId switches. Default open state follows the count of tasks +
 * automations; user-driven `?tasks=0|1` overrides the default. Width is
 * managed by the surrounding ResizablePanel in TasksWorkspaceLayout.
 */

import { Suspense } from "react";
import { TasksPanel } from "@/web/layouts/tasks-panel";

export function TasksPanelColumnInner() {
  return (
    <div className="h-full bg-sidebar pb-1">
      <div className="h-full p-0.5 pt-0.25">
        <div className="h-full bg-background rounded-[0.75rem] overflow-hidden card-shadow">
          <TasksPanel />
        </div>
      </div>
    </div>
  );
}

export function TasksPanelColumn() {
  return (
    <Suspense fallback={null}>
      <TasksPanelColumnInner />
    </Suspense>
  );
}
