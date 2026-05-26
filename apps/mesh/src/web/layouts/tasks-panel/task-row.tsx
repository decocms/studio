import { cn } from "@deco/ui/lib/utils.js";
import { Archive, Zap } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useVirtualMCP } from "@decocms/mesh-sdk";
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
}: {
  task: Task;
  isActive: boolean;
  onClick: () => void;
  onArchive: () => void;
  showAutomationBadge?: boolean;
}) {
  const config = getStatusConfig(task.status);
  const StatusIcon = config.icon;
  const isToolCallRun = task.metadata?.kind === "tool_call_run";
  const virtualMcp = useVirtualMCP(
    isToolCallRun ? undefined : task.virtual_mcp_id,
  );
  const githubRepo = getActiveGithubRepo(virtualMcp);
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
        isActive
          ? "bg-accent text-accent-foreground shadow-sm"
          : "hover:bg-accent/60",
      )}
    >
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
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground/60 min-w-0">
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
        <span
          className="[grid-area:slot] flex size-7 items-center justify-center transition-opacity group-hover/row:opacity-0"
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Archive task"
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
              className="[grid-area:slot] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 transition-opacity flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
