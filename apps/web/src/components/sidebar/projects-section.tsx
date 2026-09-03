/**
 * The sidebar's project list, with what each one needs FROM YOU nested under
 * it.
 *
 * Projects were reachable only through the picker, which is a popover you have
 * to open to learn anything. Listing them costs one row each and turns the
 * sidebar into the map it was already pretending to be. The nested rows are the
 * point though: a project row says where, a task row says why you would go —
 * cards assigned to you, cards whose run is waiting on a person, and cards
 * parked in review with nobody holding them.
 *
 * Everything here is read NON-BLOCKING. The sidebar paints on the first frame
 * and this section fills in; suspending it would put a skeleton in front of
 * navigation that never needed to wait.
 */

import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { ProjectIcon } from "@/components/project-icon";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { useProjectScope, useScopeId } from "@/hooks/use-project-scope";
import { taskBoardItemsQueryOptions } from "@/hooks/use-task-board-items";
import { landingTabIdFor } from "@/layouts/main-panel-tabs/tab-id";
import {
  isTaskBlocked,
  isTaskHandedToHuman,
  type TaskBoardItem,
} from "@/layouts/task-board/config";
import { taskRouteSegment } from "@/layouts/task-board/task-route";
import { authClient } from "@/lib/auth-client";
import { useStudioTools } from "@/lib/studio-tools";
import { track } from "@/lib/posthog-client";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { Link } from "@tanstack/react-router";
import {
  buildProjectIndex,
  projectsForTask,
  type ProjectIndex,
} from "@/lib/project-index";
import { SidebarNavRow } from "./nav-row";

/** Nested rows one project shows before the board takes over. */
const MAX_TASKS_PER_PROJECT = 3;

/**
 * Whether this card is waiting on THIS person.
 *
 * Three ways in, and the two that are not "assigned to me" are the ones worth
 * having: a run that called `user_ask` is stopped until someone answers, and a
 * card parked In Review with no assignee is a hand-off nobody caught. Neither
 * shows up in an assignee filter, which is exactly why they get missed.
 *
 * Terminal lanes are excluded outright — a done card assigned to you is not a
 * thing you need to do.
 *
 * Pure and exported for its test: this predicate decides what the sidebar
 * claims needs you, and getting it wrong is either a nag or a silence.
 */
export function needsAttention(
  task: TaskBoardItem,
  userId: string | undefined,
): boolean {
  if (task.status === "archived" || task.status === "done") return false;
  if (userId && task.assigneeId === userId) return true;
  return isTaskBlocked(task) || isTaskHandedToHuman(task);
}

/**
 * Each project with the cards waiting on this person, newest first.
 *
 * Attribution is the shared project index — the same rule the org home's feed
 * reads, where this used to keep a second copy of it. A run names the project
 * it ran in; a card nobody has run yet carries its repo.
 *
 * A card on a repository two projects share is listed under BOTH, because
 * nothing says which of them owes the answer. The `Map<repo, project>` this
 * replaces resolved that by iteration order and put the nudge under one
 * project at random — a silence for whoever was looking at the other.
 *
 * Pure, and exported for its test.
 */
export function tasksNeedingMeByProject(
  index: ProjectIndex,
  tasks: TaskBoardItem[],
  userId: string | undefined,
): Map<string, TaskBoardItem[]> {
  const out = new Map<string, { task: TaskBoardItem; only: boolean }[]>();
  for (const task of tasks) {
    if (!needsAttention(task, userId)) continue;
    const named = projectsForTask(task, index);
    for (const project of named) {
      const bucket = out.get(project.id) ?? [];
      bucket.push({ task, only: named.length === 1 });
      out.set(project.id, bucket);
    }
  }

  /**
   * A card this project alone owns outranks one it merely shares, THEN newest
   * first. Without the first key the cap is spent on a monorepo's ambiguous
   * cards — which are listed under every sibling — and evicts the one card that
   * unambiguously belongs here.
   */
  const listed = new Map<string, TaskBoardItem[]>();
  for (const [id, bucket] of out) {
    bucket.sort(
      (a, b) =>
        Number(b.only) - Number(a.only) ||
        (b.task.updatedAt ?? "").localeCompare(a.task.updatedAt ?? ""),
    );
    listed.set(
      id,
      bucket.slice(0, MAX_TASKS_PER_PROJECT).map((entry) => entry.task),
    );
  }
  return listed;
}

/**
 * One nested card, with the tree line that ties it to its project.
 *
 * The elbow is drawn rather than bordered on a wrapper so the trunk STOPS at
 * the last child: a wrapper border runs the full height of the group and left
 * a stub hanging below the final row.
 */
function TaskRow({
  task,
  orgSlug,
  isLast,
  onNavigate,
}: {
  task: TaskBoardItem;
  orgSlug: string;
  isLast: boolean;
  onNavigate?: () => void;
}) {
  return (
    <li className="relative">
      {/* Down from the project row, then curving into this one. */}
      <span
        aria-hidden="true"
        className="absolute top-0 left-4 h-1/2 w-3 rounded-bl-lg border-b border-l border-sidebar-border"
      />
      {!isLast && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 bottom-0 left-4 border-l border-sidebar-border"
        />
      )}
      <Link
        to="/$org/tasks/{-$taskKey}"
        params={{ org: orgSlug, taskKey: taskRouteSegment(orgSlug, task) }}
        onClick={() => {
          track("sidebar_attention_task_clicked", { status: task.status });
          onNavigate?.();
        }}
        className="flex h-8 items-center rounded-lg pr-2 pl-9 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <span className="truncate">{task.title}</span>
      </Link>
    </li>
  );
}

export function SidebarProjectsSection({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const t = useT();
  const collapsed = useSidebarCollapsed();
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const { projects } = useProjectScope();
  const scopeId = useScopeId();
  const navigateToAgent = useNavigateToAgent();
  const { data: session } = authClient.useSession();

  /** Non-blocking, and it shares the board's key — the same request the Tasks
   *  page and the org home already make, never a second one. */
  const { data } = useQuery({
    ...taskBoardItemsQueryOptions(locator, studio),
    enabled: !collapsed && !scopeId,
  });
  /** ORG scope only. Inside a project the sidebar is already about THAT
   *  project — its own views sit right above this — so a list of every project
   *  underneath them turns the one place that says where you are into a place
   *  that says where you could be instead. The picker and the way back out are
   *  the controls for leaving; this section is the org's map.
   *  Collapsed keeps the rows at icon width; only the heading and the nested task rows drop, having no icon to be. */
  if (scopeId || projects.length === 0) return null;

  const byProject = tasksNeedingMeByProject(
    buildProjectIndex(projects),
    data?.items ?? [],
    session?.user?.id,
  );

  return (
    <div
      className={cn("flex flex-col gap-1", collapsed && "pt-3")}
      data-tour={LAYOUT_TOUR_ANCHORS.projects}
    >
      {/* The heading carries the gap that separates the org's map from the
          destinations above it; collapsed, the container carries it instead. */}
      {!collapsed && (
        <p className="px-2 pt-5 pb-0.5 text-xs font-medium text-muted-foreground/60">
          {t("sidebar.projects.heading")}
        </p>
      )}
      <SidebarMenu className="gap-1">
        {projects.map((project) => {
          const tasks = byProject.get(project.id) ?? [];
          return (
            <SidebarNavRow
              key={project.id}
              icon={<ProjectIcon icon={project.icon} name={project.title} />}
              label={project.title}
              isActive={project.id === scopeId}
              /** A button, not a link: these resolve a SESSION, so the
               *  destination id is not knowable at render time — the same
               *  reason `ProjectNav`'s rows are buttons. */
              onSelect={() => {
                track("sidebar_project_clicked");
                navigateToAgent(project.id, {
                  view: landingTabIdFor(project.metadata?.ui?.layout),
                });
                onNavigate?.();
              }}
            >
              {!collapsed && tasks.length > 0 && (
                <ul className="flex flex-col">
                  {tasks.map((task, index) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      orgSlug={org.slug}
                      isLast={index === tasks.length - 1}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              )}
            </SidebarNavRow>
          );
        })}
      </SidebarMenu>
    </div>
  );
}
