/**
 * Home tasks panel — the fixed top of the Overview (not a tile).
 *
 * An agent summary line (the "resume", with the Super Agent icon) derived from
 * the live task board, then the tasks that need attention as the same rows the
 * kanban shows, with status tabs. Always present above the customizable card
 * board (the metric tiles).
 */
import { type ReactNode, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatTimeAgo } from "@/lib/format-time";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ArrowUpRight, Calendar, Flag01, Plus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { useMembers } from "@/hooks/use-members";
import { useT } from "@/i18n/use-t.ts";
import {
  useTaskBoardItemActions,
  useTaskBoardItems,
} from "@/hooks/use-task-board-items";
import {
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  type TaskBoardItem,
  type TaskBoardItemStatus,
} from "@/layouts/task-board/config";
import { TaskBoardItemDialog } from "@/layouts/task-board/task-dialog";

interface OrgMember {
  userId: string;
  user?: { name?: string; email?: string; image?: string | null };
}

type TaskTab =
  | "all"
  | Extract<TaskBoardItemStatus, "in_progress" | "in_review" | "done">;

const TASK_TABS: { id: TaskTab; labelKey: string }[] = [
  { id: "all", labelKey: "home.homeTasks.tabAll" },
  { id: "in_progress", labelKey: "home.homeTasks.tabInProgress" },
  { id: "in_review", labelKey: "home.homeTasks.tabInReview" },
  { id: "done", labelKey: "home.homeTasks.tabDone" },
];

/** Rows shown before the trailing "See all tasks" link. */
const MAX_VISIBLE_TASKS = 4;

function TaskRow({
  task,
  assignee,
  onOpen,
}: {
  task: TaskBoardItem;
  assignee?: OrgMember;
  onOpen: () => void;
}) {
  const statusConfig = STATUS_CONFIG[task.status];
  const StatusIcon = statusConfig.icon;
  const priority = PRIORITY_CONFIG[task.priority];
  const assigneeName =
    assignee?.user?.name ?? assignee?.user?.email?.split("@")[0] ?? null;
  const when = formatTimeAgo(new Date(task.updatedAt));
  const due = task.dueDate
    ? {
        label: new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        }).format(new Date(task.dueDate)),
        overdue: new Date(task.dueDate).getTime() < Date.now(),
      }
    : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl bg-card px-4 py-3.5 text-left card-shadow transition-colors hover:bg-accent/60"
    >
      <StatusIcon
        className={cn("size-4 shrink-0", statusConfig.iconClassName)}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {task.title}
      </span>
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        {/* Tags the board card shows (assignee, priority, when), dropped
            progressively as the panel narrows so the title keeps room. */}
        <span className="hidden @2xl:inline-flex">
          <Avatar
            shape="circle"
            size="2xs"
            url={assignee?.user?.image ?? undefined}
            fallback={(assigneeName ?? "?").slice(0, 2).toUpperCase()}
          />
        </span>
        <Flag01 className={cn("size-3.5 shrink-0", priority.flagClassName)} />
        {due && (
          <span
            className={cn(
              "hidden items-center gap-1 @xl:inline-flex",
              due.overdue ? "text-red-600" : "",
            )}
          >
            <Calendar className="size-3" />
            {due.label}
          </span>
        )}
        <span className="hidden @xl:inline">{when}</span>
      </div>
    </button>
  );
}

function buildSummary(
  tasks: TaskBoardItem[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const active = tasks.filter((t) => t.status !== "done");
  if (active.length === 0) {
    return "";
  }
  const inProgress = active.filter((t) => t.status === "in_progress").length;
  const inReview = active.filter((t) => t.status === "in_review").length;
  const highPriority = active.filter(
    (t) => t.priority === "urgent" || t.priority === "high",
  ).length;
  const overdue = active.filter(
    (t) => t.dueDate && new Date(t.dueDate).getTime() < Date.now(),
  ).length;

  const breakdown: string[] = [];
  if (inProgress > 0)
    breakdown.push(
      t("home.homeTasks.breakdownInProgress", { count: inProgress }),
    );
  if (inReview > 0)
    breakdown.push(
      t("home.homeTasks.breakdownNeedsReview", { count: inReview }),
    );

  let lead = t("home.homeTasks.summaryLead", { count: active.length });
  if (breakdown.length > 0) lead += ` — ${breakdown.join(", ")}`;
  lead += ".";

  const notes: string[] = [];
  if (highPriority > 0)
    notes.push(t("home.homeTasks.noteHighPriority", { count: highPriority }));
  if (overdue > 0)
    notes.push(t("home.homeTasks.noteOverdue", { count: overdue }));

  return notes.length > 0 ? `${lead} ${notes.join(" ")}` : lead;
}

export function HomeTasks({ afterSummary }: { afterSummary?: ReactNode }) {
  const t = useT();
  const navigate = useNavigate();
  const { items, error } = useTaskBoardItems();
  const actions = useTaskBoardItemActions();
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as OrgMember[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m] as const));
  const [tab, setTab] = useState<TaskTab>("all");
  const [createOpen, setCreateOpen] = useState(false);

  // Keep the home surface usable if the task query fails.
  const tasks = error ? [] : items;
  const sorted = [...tasks].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  const summary = buildSummary(tasks, (key, vars) =>
    t(key as never, vars as never),
  );
  const filtered =
    tab === "all" ? sorted : sorted.filter((t) => t.status === tab);

  // Open the task board in the main panel next to chat (same as the Tasks
  // toolbar toggle).
  const openBoard = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: "board" }),
    });

  return (
    <div className="flex flex-col gap-10">
      <div className="flex items-start gap-4 animate-in fade-in slide-in-from-top-1 duration-300">
        <SuperAgentIcon size={24} className="mt-0.5" />
        <p className="max-w-3xl text-lg font-medium leading-snug text-foreground">
          {summary}
        </p>
      </div>

      {afterSummary}

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-medium text-foreground">
            {t("home.homeTasks.tasksHeading")}
          </h2>
          <div className="flex items-center gap-1">
            {TASK_TABS.map((tabItem) => (
              <button
                key={tabItem.id}
                type="button"
                onClick={() => setTab(tabItem.id)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  tab === tabItem.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(tabItem.labelKey as never)}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-card px-4 py-10 text-center card-shadow">
            <p className="text-sm text-muted-foreground">
              {tab === "all"
                ? t("home.homeTasks.emptyStateNoTasks")
                : t("home.homeTasks.emptyStateNothing", {
                    status:
                      tab === "in_progress"
                        ? t("home.homeTasks.statusInProgress")
                        : tab === "in_review"
                          ? t("home.homeTasks.statusInReview")
                          : t("home.homeTasks.statusDone"),
                  })}
            </p>
            {tab === "all" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateOpen(true)}
                className="gap-2"
              >
                <Plus className="size-4" />
                {t("home.homeTasks.createNewTask")}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.slice(0, MAX_VISIBLE_TASKS).map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                assignee={
                  task.assigneeId
                    ? memberByUserId.get(task.assigneeId)
                    : undefined
                }
                onOpen={openBoard}
              />
            ))}
            <button
              type="button"
              onClick={openBoard}
              className="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-card px-4 py-3 text-sm font-medium text-muted-foreground card-shadow transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              {t("home.homeTasks.seeAllTasks")}
              <ArrowUpRight className="size-3.5" />
            </button>
          </div>
        )}
      </section>

      <TaskBoardItemDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        isSaving={actions.create.isPending}
        onSubmit={(input) => {
          actions.create.mutate(input);
          setCreateOpen(false);
        }}
      />
    </div>
  );
}
