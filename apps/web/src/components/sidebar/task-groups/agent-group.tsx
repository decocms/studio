import { ChevronDown, ChevronRight } from "@untitledui/icons";
import { TaskRow } from "@/layouts/tasks-panel/task-row";
import type { Task } from "@/components/chat/task/types";
import { useGroupExpanded } from "./use-group-expanded";
import type { SidebarFilters } from "./next-page-offset";
import { AgentAvatar } from "@/components/agent-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCPs,
} from "@/sdk";

/**
 * One "room" in the room view: an agent and its threads nested one layer down.
 * A room is the agent — a code agent is its repo, a plain agent its subject —
 * and the threads inside are its conversations. The header is the agent
 * (avatar + name, GitHub mark when repo-backed); the body is its threads.
 *
 * Groups are built by `groupThreadsByVirtualMcp`, so a threadless synthetic key
 * (tool-call runs) can land here with no matching agent — it renders under a
 * neutral "Other" label rather than breaking.
 */
export function AgentGroup({
  virtualMcpId,
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  canArchive,
  filters,
  defaultExpanded,
}: {
  virtualMcpId: string;
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  canArchive: boolean;
  filters: SidebarFilters;
  defaultExpanded: boolean;
}) {
  const agents = useVirtualMCPs();
  const { org } = useProjectContext();
  const decopilot = getWellKnownDecopilotVirtualMCP(org.id);
  const agent =
    agents?.find((a) => a.id === virtualMcpId) ??
    (virtualMcpId === decopilot.id ? decopilot : undefined);

  const [expanded, setExpanded] = useGroupExpanded(
    `agent-${virtualMcpId}`,
    defaultExpanded,
  );

  const label = agent?.title ?? "Other";
  const isCode = agent ? agentHasClonableSource(agent.metadata) : false;

  return (
    <div className="flex flex-col gap-0.5">
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
        className="group/group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium text-foreground cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors"
      >
        <div className="relative size-5 shrink-0 flex items-center justify-center">
          <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/group:opacity-0">
            <AgentAvatar icon={agent?.icon ?? null} name={label} size="xs" />
          </span>
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/group:opacity-100">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </div>
        <span className="flex-1 truncate">{label}</span>
        {isCode && (
          <GitHubIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="size-5 shrink-0 flex items-center justify-center">
          <span className="text-xs text-muted-foreground tabular-nums">
            {threads.length}
          </span>
        </div>
      </div>
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1 pl-4">
          {threads.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isActive={activeTaskId === task.id}
              onClick={() => onSelectTask(task)}
              onArchive={
                canArchive && task.created_by === filters.currentUserId
                  ? () => onArchiveTask(task)
                  : undefined
              }
              showAutomationBadge={Boolean(task.trigger_id)}
              hideStatusIdle
              indented
            />
          ))}
        </div>
      )}
    </div>
  );
}
