/**
 * Recent activity — what the org's agents have been doing lately.
 *
 * Org-wide task cards, newest write first. A task is tied to a project through
 * its threads (`threads[].virtualMcpId`), so the row borrows that agent's
 * avatar and name; a task nothing links to gets a neutral monogram rather than
 * a borrowed identity.
 */

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { cn } from "@decocms/ui/lib/utils.ts";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { AgentAvatar } from "@/components/agent-icon";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  taskBoardItemsQueryOptions,
  useBoardColumns,
} from "@/hooks/use-task-board-items";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import {
  laneHeader,
  laneVisual,
  type TaskBoardItem,
} from "@/layouts/task-board/config";
import { taskRouteSegment } from "@/layouts/task-board/task-route";
import { formatTimeAgo } from "@/lib/format-time";
import { useT } from "@/i18n/use-t.ts";

/** Rows the column shows. Longer than this is the task board's job. */
const MAX_ROWS = 5;

/** The agent a task belongs to, via the first of its threads that names one. */
function taskProject(
  task: TaskBoardItem,
  agentsById: Map<string, VirtualMCPEntity>,
): VirtualMCPEntity | null {
  for (const thread of task.threads) {
    const id = thread.virtualMcpId;
    if (!id) continue;
    const agent = agentsById.get(id);
    if (agent) return agent;
  }
  return null;
}

function ActivityRow({
  task,
  project,
  laneLabel,
  isLast,
  onOpen,
}: {
  task: TaskBoardItem;
  project: VirtualMCPEntity | null;
  laneLabel: string;
  isLast: boolean;
  onOpen: () => void;
}) {
  const visual = laneVisual(task.status);
  const StatusIcon = visual.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex h-14 w-full items-center gap-3 px-2 text-left transition-colors hover:bg-accent/50",
        "focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !isLast && "border-b border-border",
      )}
    >
      {project ? (
        <AgentAvatar
          icon={project.icon}
          name={project.title}
          size="sm"
          className="shrink-0"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-medium text-muted-foreground">
          {(task.title.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">
          {task.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <StatusIcon className={cn("size-3 shrink-0", visual.iconClassName)} />
          <span className="truncate">{laneLabel}</span>
          {project && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{project.title}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0">
            {formatTimeAgo(new Date(task.updatedAt))}
          </span>
        </span>
      </span>
    </button>
  );
}

/**
 * The rows this column would show, exported so the PAGE can decide the grid:
 * an empty activity column is not rendered at all and the roster spans the full
 * width, rather than a half-width "nothing here yet" panel sitting beside it.
 * Both callers observe the same cached query, so this costs no extra fetch.
 *
 * A failed board reads as empty — the roster beside this column is the page's
 * reason to exist and must not go down with it.
 */
function toRecent(items: TaskBoardItem[]): TaskBoardItem[] {
  return items
    .filter((task) => task.status !== "archived")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, MAX_ROWS);
}

/**
 * The same rows, read with SUSPENSE.
 *
 * The org home has to know whether there is activity BEFORE it can lay itself
 * out — with activity the roster takes half the row, without it the full width
 * — and a non-suspense read answers "no" first and "yes" a moment later, which
 * is a layout shift on every visit to a board that has anything on it. This
 * shares the board's query key, so it is the same request, just awaited.
 */
export function useRecentTasksSuspense(): TaskBoardItem[] {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const { data } = useSuspenseQuery(
    taskBoardItemsQueryOptions(locator, studio),
  );
  return toRecent(data.items);
}

export function RecentActivity({ agents }: { agents: VirtualMCPEntity[] }) {
  const t = useT();
  const navigate = useNavigate();
  const orgSlug = useParams({ strict: false }).org ?? "";
  /** The lanes only — `useTaskBoardItems` also opens the board's SSE
   *  subscriptions, and a lane LABEL should not cost the org home a stream. */
  const columns = useBoardColumns();
  const recent = useRecentTasksSuspense();

  const agentsById = new Map(agents.map((agent) => [agent.id, agent] as const));

  /** The page gates on `useRecentTasksSuspense`, so this is unreachable from
   *  it; the
   *  guard keeps the component honest for any other caller. */
  if (recent.length === 0) return null;

  return (
    <section
      className="flex flex-col gap-4"
      data-tour={LAYOUT_TOUR_ANCHORS.recentActivity}
    >
      {/* `h-8` matches the agents header, whose height is set by its import
          button — without it the two lists start on different lines. */}
      <div className="flex h-8 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("home.orgHome.recentActivity")}
        </h2>
        {/* Mirrors the import button opposite it, so both headers carry an
            action and the two lists still start on the same line. */}
        <Link
          to={DESTINATION_ROUTE.tasks}
          params={{ org: orgSlug }}
          className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("home.orgHome.viewAll")}
        </Link>
      </div>
      <div className="flex flex-col border-t border-border">
        {recent.map((task, index) => (
          <ActivityRow
            key={task.id}
            task={task}
            isLast={index === recent.length - 1}
            project={taskProject(task, agentsById)}
            laneLabel={laneHeader(task.status, t, columns).label}
            onOpen={() =>
              navigate({
                to: "/$org/tasks/{-$taskKey}",
                params: {
                  org: orgSlug,
                  taskKey: taskRouteSegment(orgSlug, task),
                },
              })
            }
          />
        ))}
      </div>
    </section>
  );
}
