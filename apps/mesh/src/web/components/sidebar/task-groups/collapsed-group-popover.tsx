import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@deco/ui/components/hover-card.tsx";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Plus } from "@untitledui/icons";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";

export interface CollapsedGroupPopoverProps {
  virtualMcpId: string;
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onNewTaskInGroup: (virtualMcpId: string) => void;
}

/**
 * In collapsed rail state, each VM group is represented by its avatar.
 * Hovering opens a popover preview that shows the same accordion body.
 */
export function CollapsedGroupPopover({
  virtualMcpId,
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  onNewTaskInGroup,
}: CollapsedGroupPopoverProps) {
  const entity = useVirtualMCP(virtualMcpId);
  const latestTask = threads[0];

  const handleClick = () => {
    if (latestTask) {
      onSelectTask(latestTask);
    } else {
      onNewTaskInGroup(virtualMcpId);
    }
  };

  return (
    <HoverCard
      openDelay={120}
      closeDelay={150}
      onOpenChange={(next) => {
        if (next) {
          track("sidebar_group_hover_popover_opened", {
            virtual_mcp_id: virtualMcpId,
          });
        }
      }}
    >
      <SidebarMenuItem>
        <HoverCardTrigger asChild>
          <SidebarMenuButton
            onClick={handleClick}
            isActive={Boolean(
              latestTask && activeTaskId && latestTask.id === activeTaskId,
            )}
          >
            <AgentAvatar
              icon={entity?.icon ?? null}
              name={entity?.title ?? "?"}
              size="sm+"
            />
          </SidebarMenuButton>
        </HoverCardTrigger>
      </SidebarMenuItem>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 p-2"
      >
        <div className="flex items-center justify-between px-1 pb-1 text-xs font-medium">
          <span className="truncate">{entity?.title ?? "Agent"}</span>
          <button
            type="button"
            aria-label="New task in this agent"
            onClick={() => onNewTaskInGroup(virtualMcpId)}
            className="flex size-6 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-0.5 max-h-[60vh] overflow-y-auto">
          {threads.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No tasks yet
            </div>
          ) : (
            threads.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isActive={activeTaskId === task.id}
                onClick={() => onSelectTask(task)}
                onArchive={() => onArchiveTask(task)}
                showAutomationBadge={Boolean(task.trigger_id)}
              />
            ))
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
