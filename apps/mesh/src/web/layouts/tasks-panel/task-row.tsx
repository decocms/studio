import { cn } from "@deco/ui/lib/utils.js";
import { Archive, Zap } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { getStatusConfig } from "@/web/lib/task-status";
import { formatTimeAgo } from "@/web/lib/format-time";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { isSyntheticBranch } from "@/shared/is-synthetic-branch";
import { useClockTick } from "@/web/lib/use-clock-tick";
import type { Task } from "@/web/components/chat/task/types";

export function TaskRow({
  task,
  isActive,
  onClick,
  onArchive,
  showAutomationBadge,
  showAgentIcon,
  alwaysShowArchive,
}: {
  task: Task;
  isActive: boolean;
  onClick: () => void;
  onArchive: () => void;
  showAutomationBadge?: boolean;
  /** Render the originating agent's icon on the left of the row. */
  showAgentIcon?: boolean;
  /** When true, render the archive button permanently and hide the status
   *  icon (the parent group header already conveys status). Otherwise the
   *  status icon shows by default and swaps to archive on hover. */
  alwaysShowArchive?: boolean;
}) {
  const config = getStatusConfig(task.status);
  const StatusIcon = config.icon;
  const isToolCallRun = task.metadata?.kind === "tool_call_run";
  const virtualMcp = useVirtualMCP(
    isToolCallRun ? undefined : task.virtual_mcp_id,
  );
  const githubRepo = getActiveGithubRepo(virtualMcp);
  // Subscribe to a 60s heartbeat so the relative timestamp re-renders even
  // when `task` is referentially stable.
  useClockTick(60_000);

  const isAutomation = showAutomationBadge || Boolean(task.trigger_id);

  return (
    <div
      data-task-id={task.id}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group/row flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
        "focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-ring/50",
        isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      )}
    >
      {showAgentIcon && !isToolCallRun && (
        <AgentAvatar
          icon={virtualMcp?.icon ?? null}
          name={virtualMcp?.title ?? "?"}
          size="2xs"
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {isAutomation && (
            <Zap
              size={12}
              aria-label="Automation-triggered"
              className="shrink-0 text-blue-500"
            />
          )}
          <div className="text-sm text-foreground truncate">
            {task.title || "Untitled task"}
          </div>
        </div>
        {task.updated_at && (
          <div
            className={cn(
              "flex items-center gap-1 text-[11px] min-w-0",
              isActive
                ? "text-accent-foreground/70"
                : "text-muted-foreground/60",
            )}
          >
            {task.branch && !isSyntheticBranch(task.branch) ? (
              <>
                <span className="truncate font-mono">{task.branch}</span>
                <span className="shrink-0">·</span>
              </>
            ) : githubRepo ? (
              <>
                <span className="truncate">
                  {githubRepo.owner}/{githubRepo.name}
                </span>
                <span className="shrink-0">·</span>
              </>
            ) : null}
            <span className="shrink-0">
              {formatTimeAgo(new Date(task.updated_at))}
            </span>
          </div>
        )}
      </div>
      <div className="shrink-0 grid [grid-template-areas:'slot'] items-center justify-items-center">
        {!alwaysShowArchive && (
          <span
            className="[grid-area:slot] flex size-7 items-center justify-center pointer-events-none transition-opacity group-hover/row:opacity-0"
            aria-label={config.label}
          >
            <StatusIcon
              size={14}
              className={cn(
                config.iconClassName,
                task.status === "in_progress" && "animate-spin",
              )}
            />
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Archive task"
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
              className={cn(
                "[grid-area:slot] flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-opacity",
                alwaysShowArchive
                  ? "opacity-100"
                  : "opacity-0 pointer-events-none group-hover/row:opacity-100 group-hover/row:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto",
              )}
            >
              <Archive size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Archive</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
