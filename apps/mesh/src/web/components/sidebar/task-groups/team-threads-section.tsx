import { useState } from "react";
import { ArrowNarrowRight } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";
import { SidebarSectionHeader } from "./sidebar-section-header";
import { ScrollFade } from "./scroll-fade";

/** How many teammate threads to preview inline before deferring to "See all". */
const TEAM_PREVIEW_LIMIT = 8;

/**
 * Other members' threads, presented as a peer of the "My threads" / "Agents"
 * sections: a small uppercase section label that also toggles the list open.
 * Collapsed by default. "See all" jumps to the monitoring Threads tab (the full,
 * paginated view) so the sidebar stays a preview, not a second monitor.
 *
 * Rows match "My threads" (non-indented, agent icon) but are read-only — no
 * `onArchive`, since archiving hides a thread org-wide and must not happen from
 * a glance at a teammate's work.
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
    <>
      <SidebarSectionHeader
        label="Team threads"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        count={threads.length}
        controlsId="sidebar-section-team-threads"
        action={{
          label: "See all",
          icon: <ArrowNarrowRight size={11} />,
          onClick: seeAll,
        }}
      />
      <div
        id="sidebar-section-team-threads"
        aria-hidden={!open}
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <ScrollFade className="flex flex-col gap-0.5 max-h-[30vh] overflow-y-auto overscroll-contain">
            {preview.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isActive={activeTaskId === task.id}
                onClick={() => onSelectTask(task)}
                showAutomationBadge={Boolean(task.trigger_id)}
                showAgentIcon
              />
            ))}
            {hasOverflow && (
              <button
                type="button"
                onClick={seeAll}
                className="flex items-center gap-1 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span>See all {threads.length} team threads</span>
                <ArrowNarrowRight size={12} />
              </button>
            )}
          </ScrollFade>
        </div>
      </div>
    </>
  );
}
