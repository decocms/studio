import { ChevronDown, ChevronRight, Plus } from "@untitledui/icons";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { cn } from "@deco/ui/lib/utils.ts";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import { TOOL_CALL_RUNS_GROUP_KEY } from "./group-threads";
import { useGroupExpanded } from "./use-group-expanded";
import type { Task } from "@/web/components/chat/task/types";

export interface TaskGroupProps {
  virtualMcpId: string;
  threads: Task[];
  isDecopilot: boolean;
  /** Whether this group currently contains the active task — drives default expanded. */
  hasActiveTask: boolean;
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onNewTaskInGroup: (virtualMcpId: string) => void;
  /** When true, the group renders dimmed (used when filters wipe out the body). */
  dimmed: boolean;
}

export function TaskGroup({
  virtualMcpId,
  threads,
  isDecopilot,
  hasActiveTask,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  onNewTaskInGroup,
  dimmed,
}: TaskGroupProps) {
  const defaultExpanded = isDecopilot || hasActiveTask;
  const [expanded, setExpanded] = useGroupExpanded(
    virtualMcpId,
    defaultExpanded,
  );
  const isToolCallRuns = virtualMcpId === TOOL_CALL_RUNS_GROUP_KEY;

  return (
    <div className={cn("flex flex-col", dimmed && "opacity-50")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        className={cn(
          "group/group flex items-center gap-2 px-2 py-1 rounded-md text-sm font-semibold text-foreground",
          "cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors",
        )}
      >
        <div className="relative size-5 shrink-0 flex items-center justify-center">
          <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/group:opacity-0">
            <TaskGroupAvatar
              virtualMcpId={virtualMcpId}
              isToolCallRuns={isToolCallRuns}
            />
          </span>
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/group:opacity-100">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </div>
        <span className="flex-1 truncate">
          <TaskGroupLabel
            virtualMcpId={virtualMcpId}
            isToolCallRuns={isToolCallRuns}
          />
        </span>
        {!isToolCallRuns && !dimmed && (
          <button
            type="button"
            aria-label="New task in this agent"
            onClick={(e) => {
              e.stopPropagation();
              onNewTaskInGroup(virtualMcpId);
            }}
            className="opacity-0 group-hover/group:opacity-100 focus-visible:opacity-100 transition-opacity flex size-7 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1 pl-2">
          {threads.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isActive={activeTaskId === task.id}
              onClick={() => onSelectTask(task)}
              onArchive={() => onArchiveTask(task)}
              showAutomationBadge={Boolean(task.trigger_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskGroupAvatar({
  virtualMcpId,
  isToolCallRuns,
}: {
  virtualMcpId: string;
  isToolCallRuns: boolean;
}) {
  if (isToolCallRuns) {
    return <AgentAvatar icon={null} name="⚙" size="xs" />;
  }
  return <TaskGroupAvatarInner virtualMcpId={virtualMcpId} />;
}

function TaskGroupAvatarInner({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  if (!entity) return <AgentAvatar icon={null} name="?" size="xs" />;
  return (
    <AgentAvatar icon={entity.icon ?? null} name={entity.title} size="xs" />
  );
}

function TaskGroupLabel({
  virtualMcpId,
  isToolCallRuns,
}: {
  virtualMcpId: string;
  isToolCallRuns: boolean;
}) {
  if (isToolCallRuns) return <>Automation runs</>;
  return <TaskGroupLabelInner virtualMcpId={virtualMcpId} />;
}

function TaskGroupLabelInner({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  return <>{entity?.title ?? "Agent"}</>;
}
