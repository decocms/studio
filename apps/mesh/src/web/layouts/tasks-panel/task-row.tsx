import { cn } from "@deco/ui/lib/utils.js";
import { Archive } from "@untitledui/icons";
import { useEffect, useRef } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { McpAvatar } from "./mcp-avatar";
import { getStatusConfig } from "@/web/lib/task-status";
import { formatTimeAgo } from "@/web/lib/format-time";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
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
  const virtualMcp = useVirtualMCP(task.virtual_mcp_id);
  const githubRepo = getActiveGithubRepo(virtualMcp);
  const rowRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs route-selected task row with the scrollable tasks panel DOM
  useEffect(() => {
    if (!isActive) return;
    const row = rowRef.current;
    if (!row) return;

    row.focus({ preventScroll: true });
    row.scrollIntoView({
      behavior: "smooth",
      block: "start",
      inline: "nearest",
    });
  }, [isActive, task.id]);

  return (
    <div
      ref={rowRef}
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
        "group/row flex items-center gap-3 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
        "focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-ring/50",
        isActive ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <McpAvatar
        virtualMcpId={task.virtual_mcp_id}
        size="xs"
        showAutomationBadge={showAutomationBadge}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground truncate">
          {task.title || "Untitled task"}
        </div>
        {task.updated_at && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
            {task.branch ? (
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
          className="[grid-area:slot] flex size-7 items-center justify-center group-hover/row:invisible"
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
              className="[grid-area:slot] invisible group-hover/row:visible flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
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
