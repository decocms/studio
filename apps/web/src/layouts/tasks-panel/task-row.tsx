import { cn } from "@decocms/ui/lib/utils.ts";
import { Archive, Zap } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useVirtualMCP } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { AgentAvatar } from "@/components/agent-icon";
import { getStatusConfig } from "@/lib/task-status";
import { formatTimeAgo } from "@/lib/format-time";
import { getActiveGithubRepo } from "@/lib/github-repo";
import { isSyntheticBranch } from "@decocms/shared/is-synthetic-branch";
import { useClockTick } from "@/lib/use-clock-tick";
import type { Task } from "@/components/chat/task/types";

export function TaskRow({
  task,
  isActive,
  onClick,
  onArchive,
  showAutomationBadge,
  showAgentIcon,
  hideStatusIdle,
  indented,
}: {
  task: Task;
  isActive: boolean;
  onClick: () => void;
  /** Omit to render a read-only row with no archive affordance (e.g. another
   *  member's thread, where archiving would hide it org-wide). */
  onArchive?: () => void;
  showAutomationBadge?: boolean;
  /** Render the originating agent's icon on the left of the row. */
  showAgentIcon?: boolean;
  /** When true, the row shows nothing at rest (group header already conveys
   *  status); the archive button still appears on hover. When false/omitted,
   *  the status icon shows at rest and swaps to archive on hover. */
  hideStatusIdle?: boolean;
  /** When true (inside a sidebar group), the button area stretches out to the
   *  group's left edge while the content keeps its indented position, so the
   *  clickable/hover surface spans the full sidebar width. */
  indented?: boolean;
}) {
  const t = useT();
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
        "group/row flex items-center gap-2 py-1.5 rounded-md cursor-pointer transition-colors",
        // Indented rows stretch their background out to the group's left edge
        // (-ml-4 cancels the wrapper's pl-4) while pl-6 keeps the content where
        // it sat before, so the button surface spans the full sidebar width.
        // Flat rows use pl-[7px] so the (smaller, 20px) agent avatar centers on
        // the same x=25 axis as the org icon and the sidebar-toggle glyph (that
        // axis is the collapsed icon-rail's midpoint, so nothing shifts between
        // open/collapsed). No right padding: the status/archive slot then reaches
        // the same right edge as the toolbar's search / new buttons.
        indented ? "-ml-4 pl-6" : "pl-[7px]",
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
              aria-label={t("tasksPanel.taskRow.automationTriggered")}
              className="shrink-0 text-blue-500"
            />
          )}
          <div className="text-sm text-foreground truncate">
            {task.title || t("tasksPanel.taskRow.untitledTask")}
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
        {!hideStatusIdle && (
          <span
            className={cn(
              "[grid-area:slot] flex size-8 items-center justify-center pointer-events-none transition-opacity",
              // Only fade the status icon on hover when there's an archive
              // button to reveal underneath it.
              onArchive && "group-hover/row:opacity-0",
            )}
            aria-label={t("tasksPanel.taskRow.statusLabel", {
              status: config.label,
            })}
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
        {onArchive && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("tasksPanel.taskRow.archiveTask")}
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive();
                }}
                className="[grid-area:slot] opacity-0 pointer-events-none group-hover/row:opacity-100 group-hover/row:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Archive size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("tasksPanel.taskRow.archive")}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
