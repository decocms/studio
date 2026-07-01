import { useState } from "react";
import { ArrowNarrowRight, ChevronDown, ChevronRight } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";

/** How many teammate threads to preview inline before deferring to "See all". */
const TEAM_PREVIEW_LIMIT = 8;

/**
 * Collapsed-by-default accordion of other members' threads. Expand to peek at
 * recent team activity; "See all" jumps to the monitoring Threads tab (the full,
 * paginated view) so the sidebar stays a preview, not a second monitor.
 *
 * Rows are read-only (no `onArchive`) — archiving hides a thread org-wide, which
 * must not happen from a glance at a teammate's work.
 */
export function TeamThreadsSection({
  threads,
  activeTaskId,
  onSelectTask,
  onNavigate,
}: {
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { org } = useProjectContext();

  if (threads.length === 0) return null;

  const preview = threads.slice(0, TEAM_PREVIEW_LIMIT);
  const hasOverflow = threads.length > preview.length;

  const seeAll = () => {
    track("sidebar_team_threads_see_all_clicked");
    onNavigate?.();
    navigate({
      to: "/$org/settings/monitor",
      params: { org: org.slug },
      search: { tab: "threads" },
    });
  };

  return (
    <div className="flex flex-col gap-0.5">
      <div className="group/group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/60 transition-colors">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 min-w-0 text-sm font-medium text-foreground focus-visible:outline-none"
        >
          {open ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate">Team threads</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {threads.length}
          </span>
        </button>
        <button
          type="button"
          onClick={seeAll}
          className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground opacity-0 group-hover/group:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:outline-none"
        >
          See all
          <ArrowNarrowRight size={12} />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-0.5 pb-1 pl-4">
          {preview.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isActive={activeTaskId === task.id}
              onClick={() => onSelectTask(task)}
              showAutomationBadge={Boolean(task.trigger_id)}
              showAgentIcon
              indented
            />
          ))}
          {hasOverflow && (
            <button
              type="button"
              onClick={seeAll}
              className="flex items-center gap-1 -ml-4 pl-6 pr-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span>See all {threads.length} team threads</span>
              <ArrowNarrowRight size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
