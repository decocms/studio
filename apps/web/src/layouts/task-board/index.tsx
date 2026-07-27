/**
 * Task board (/$org/board) — the org's own board of tasks (title,
 * description, status, priority, assignee), independent of chat threads.
 */

import { Fragment, useRef, useState } from "react";
import type { DragEvent } from "react";
import { getInitials } from "@/lib/get-initials";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Calendar,
  Columns03,
  HelpCircle,
  Lightning01,
  List,
  Loading01,
  Plus,
  UserPlus01,
} from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  getWellKnownDecopilotVirtualMCP,
  useConnections,
  useProjectContext,
} from "@/sdk";
import { getOrgGithubConnections } from "@decocms/shared/github-repo-scope";
import { useConnectApp } from "@/hooks/use-connect-app";
import { useMembers } from "@/hooks/use-members";
import {
  useTaskBoardItemActions,
  useTaskBoardItems,
} from "@/hooks/use-task-board-items";
import { formatTimeAgo } from "@/lib/format-time";
import {
  isTaskBlocked,
  primaryThread,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  SUPER_AGENT_ASSIGNEE_ID,
  type TaskBoardItem,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type Member,
} from "./config";
import { TaskBoardItemDialog } from "./task-dialog";
import { AssigneePickerContent } from "./assignee-picker";
import { buildTaskChatContext } from "./build-task-chat-context";
import { useStudioTools } from "@/lib/studio-tools";
import {
  EMPTY_FILTERS,
  TaskFiltersBar,
  TaskFiltersDrawer,
  taskMatchesFilters,
  type TaskFilters,
} from "./task-filters";
import { useFlipLanes } from "./use-flip-lanes";
import { usePanelActions } from "@/layouts/shell-layout";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useThreadActions } from "@/components/chat/store/hooks";
import { writeChatDraft } from "@/lib/chat-draft";
import { createMentionDoc } from "@/components/chat/tiptap/mention";
import type { TiptapDoc } from "@/components/chat/types";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import { BacklogPaywallBanner } from "./backlog-paywall";

// Warm the chat chunk so opening a task's activity doesn't cold-load it (flash).
void import("../agent-shell-layout/index.tsx").catch(() => {});

type Layout = "board" | "list";

export default function TaskBoard() {
  return (
    <div className="min-h-0 flex-1 pt-0 pr-1 pb-1 pl-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="card-shadow flex h-full flex-col overflow-hidden rounded-[0.75rem] bg-background">
          <TaskBoardPage />
        </div>
      </div>
    </div>
  );
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function formatDueDate(iso: string): { label: string; overdue: boolean } {
  const d = new Date(iso);
  const overdue = d.getTime() < Date.now();
  return { label: DATE_FMT.format(d), overdue };
}

/**
 * Shared meta chip: outlined (border, no fill), lightly rounded (not a full
 * pill), with room for a larger leading icon.
 */
const PILL =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground";

/** Card flag for a task whose agent is paused waiting on human input. */
function BlockedBadge() {
  const t = useT();
  return (
    <span
      className={cn(PILL, "border-warning/30 text-warning")}
      title={t("taskBoard.taskBoard.blockedBadgeTitle")}
    >
      <HelpCircle size={14} />
      {t("taskBoard.taskBoard.needsInput")}
    </span>
  );
}

function PriorityPill({ priority }: { priority: TaskBoardItemPriority }) {
  const t = useT();
  const config = PRIORITY_CONFIG[priority];
  return (
    <span className={PILL}>
      <span className={cn("size-2 rounded-full", config.dotClassName)} />
      {t(config.labelKey)}
    </span>
  );
}

function DueDatePill({ iso }: { iso: string }) {
  const { label, overdue } = formatDueDate(iso);
  return (
    <span
      className={cn(PILL, overdue && "border-destructive/30 text-destructive")}
    >
      <Calendar size={14} />
      {label}
    </span>
  );
}

/**
 * Assignee glyph for a card/row. For a Super Agent task it renders the
 * delegation as overlapping avatars — the assigner's avatar eclipsed by the
 * Super Agent capybara — so it's clear a human handed the task off. Otherwise a
 * plain member avatar.
 */
function AssigneeDisplay({
  item,
  assignee,
  assignedBy,
  members,
  onAssign,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  onAssign?: (userId: string | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  if (item.assigneeId === SUPER_AGENT_ASSIGNEE_ID) {
    return (
      <span
        className="inline-flex items-center"
        title={
          assignedBy?.user?.name
            ? t("taskBoard.taskBoard.assignedToSuperAgentBy", {
                name: assignedBy.user.name,
              })
            : t("taskBoard.taskBoard.assignedToSuperAgent")
        }
      >
        {assignedBy && (
          <Avatar
            url={assignedBy.user?.image ?? undefined}
            fallback={getInitials(assignedBy.user?.name)}
            shape="circle"
            size="xs"
            className="-mr-2 ring-2 ring-background"
          />
        )}
        <SuperAgentIcon size={20} className="ring-2 ring-background" />
      </span>
    );
  }
  if (assignee) {
    return (
      <Avatar
        url={assignee.user?.image ?? undefined}
        fallback={getInitials(assignee.user?.name)}
        shape="circle"
        size="xs"
      />
    );
  }
  if (!onAssign || !members?.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Assign"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground/40 transition-colors hover:border-muted-foreground hover:text-muted-foreground"
        >
          <UserPlus01 size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-0"
        align="end"
        side="bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <AssigneePickerContent
          members={members}
          onSelect={(userId) => {
            onAssign(userId);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function TaskBoardPage() {
  const t = useT();
  const { items, isLoading } = useTaskBoardItems();
  const actions = useTaskBoardItemActions();
  const reportsOnly = useReportsOnly();
  // Handing a task to the Super Agent makes it open a PR — so it needs an
  // org-level GitHub connection. Every path that assigns to the Super Agent
  // (Auto-fix, the lane assignee picker, the task dialog) prompts to connect
  // instead of enqueueing a run that can't push.
  const hasGithub =
    getOrgGithubConnections(useConnections({ slug: "mcp-github" })).length > 0;
  const [connectGithubOpen, setConnectGithubOpen] = useState(false);
  // Returns true if the assignment was blocked (connect prompt opened) so the
  // caller stops before dispatching.
  const blockSuperAgentWithoutGithub = (
    assigneeId: string | null | undefined,
  ) => {
    if (assigneeId === SUPER_AGENT_ASSIGNEE_ID && !hasGithub) {
      setConnectGithubOpen(true);
      return true;
    }
    return false;
  };
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as Member[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  const [layout, setLayout] = useState<Layout>("board");
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<TaskBoardItem | null>(null);
  // Status a newly-created task should start in (set by a lane's "+"); null for
  // the generic "New task" button.
  const [createStatus, setCreateStatus] = useState<TaskBoardItemStatus | null>(
    null,
  );
  const { setTaskId } = usePanelActions();
  const { create } = useThreadActions();
  const studio = useStudioTools();
  const { org, locator } = useProjectContext();
  const navigate = useNavigate();
  // Deep link: `/$org/board?task=<id>` opens that task's modal (from a linked
  // chat's "open in board" button). Derived, so it opens as soon as the item
  // loads without an effect.
  const { task: deepLinkTaskId } = useSearch({ strict: false }) as {
    task?: string;
  };
  const deepLinkItem = deepLinkTaskId
    ? (items.find((i) => i.id === deepLinkTaskId) ?? null)
    : null;

  const clearDeepLink = () => {
    if (deepLinkTaskId)
      navigate({
        to: "/$org/board",
        params: { org: org.slug },
        search: {},
        replace: true,
      });
  };

  // Start a fresh chat on the default Decopilot agent, seeded with the task's
  // title + description as the first user message (via the autosend buffer),
  // and link the new thread to the task so it shows on the modal.
  const startChatFromTask = async (task: TaskBoardItem) => {
    const newId = crypto.randomUUID();
    const agentId = getWellKnownDecopilotVirtualMCP(org.id).id;
    // Pull the task's linked PRs (best-effort — the chat still opens without
    // them) so the seeded context references prior work, not just the title.
    const prs = await studio
      .call("TASK_BOARD_ITEM_PRS_GET", { taskBoardItemId: task.id })
      .then((r) => r.prs)
      .catch(() => []);
    const context = buildTaskChatContext(task, prs);
    // Prefill the composer with a removable task @ref chip (not raw text) and
    // do NOT auto-send — the user reviews/adds to it, then hits send. The chip
    // expands to the task context at send time (see derive-parts).
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            createMentionDoc({
              id: task.id,
              name: task.title,
              char: "@",
              kind: "task",
              metadata: {
                title: task.title,
                description: task.description,
                context,
              },
            }),
            { type: "text", text: " " },
          ],
        },
      ],
    };
    writeChatDraft(sessionStorage, locator, newId, doc);
    setDialogOpen(false);
    try {
      await create({ id: newId, virtual_mcp_id: agentId });
      // Best-effort — a link failure shouldn't block navigating into the chat.
      await actions.link.mutateAsync({ id: task.id, linkThreadId: newId });
    } catch {
      // Toast already fired by the manager; navigate anyway so the route
      // loader's ensure-fallback can retry the create.
    }
    setTaskId(newId, agentId);
  };

  const visibleItems = items.filter((item) =>
    taskMatchesFilters(item, filters),
  );

  const openCreate = () => {
    setEditingItem(null);
    setCreateStatus(null);
    setDialogOpen(true);
  };

  const openCreateInLane = (status: TaskBoardItemStatus) => {
    setEditingItem(null);
    setCreateStatus(status);
    setDialogOpen(true);
  };

  const openEdit = (item: TaskBoardItem) => {
    setEditingItem(item);
    setDialogOpen(true);
  };

  // Opening a card always opens the task modal. The modal's activity area is
  // what navigates into the run's chat (see onOpenThread below).
  const openTask = openEdit;

  // The task the modal is editing — a locally-opened card, or the deep-linked
  // one. The modal is open when either is set.
  const activeItem = editingItem ?? deepLinkItem;
  const modalOpen = dialogOpen || !!deepLinkItem;

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingItem(null);
    setCreateStatus(null);
    clearDeepLink();
  };

  if (isLoading && items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    // Full-width so each region's scroll container spans the whole panel — the
    // max-width lives on the *content* inside (header + lanes), so the mouse can
    // sit in the empty margins on wide monitors and still scroll the board.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — capped + centered to the same width as the board content so
          they line up; content-capped, not scroll-capped. */}
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4 px-4 pt-6 sm:px-8 sm:pt-8">
        <h1 className="text-xl font-medium text-foreground">
          {t("taskBoard.taskBoard.tasksTitle")}
        </h1>

        {/* Commerce orgs: a persistent unlock CTA that self-hides once the
            diagnostic is paid. The board stays usable in the meantime. */}
        {reportsOnly && <BacklogPaywallBanner />}

        {/* Toolbar — filters on the left (inline bar on desktop, a single
            drawer button on mobile), view toggle + New task on the right. */}
        <div className="flex flex-wrap items-center gap-2">
          {items.length > 0 && (
            <>
              <div className="sm:hidden">
                <TaskFiltersDrawer
                  filters={filters}
                  members={members}
                  onChange={setFilters}
                />
              </div>
              <div className="hidden sm:block">
                <TaskFiltersBar
                  filters={filters}
                  members={members}
                  onChange={setFilters}
                />
              </div>
            </>
          )}

          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-muted p-0.5">
              <LayoutToggle
                active={layout === "list"}
                onClick={() => setLayout("list")}
                icon={List}
                label={t("common.taskBoard.listView")}
              />
              <LayoutToggle
                active={layout === "board"}
                onClick={() => setLayout("board")}
                icon={Columns03}
                label={t("common.taskBoard.boardView")}
              />
            </div>

            <Button size="sm" onClick={openCreate}>
              <Plus size={16} />
              {t("taskBoard.taskBoard.newTask")}
            </Button>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 sm:px-8">
          <div className="rounded-xl bg-card px-4 py-12 text-center text-sm text-muted-foreground card-shadow">
            {t("taskBoard.taskBoard.noTasksYet")}
          </div>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 sm:px-8">
          <div className="flex flex-col items-center gap-3 rounded-xl bg-card px-4 py-12 text-center text-sm text-muted-foreground card-shadow">
            {t("taskBoard.taskBoard.noTasksMatch")}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
              {t("taskBoard.taskBoard.clearFilters")}
            </Button>
          </div>
        </div>
      ) : layout === "board" ? (
        <Lanes
          items={visibleItems}
          members={members}
          memberByUserId={memberByUserId}
          onOpen={openTask}
          onCreate={openCreateInLane}
          onMove={(id, status, sortOrder) =>
            actions.update.mutate({ id, status, sortOrder })
          }
          onAssign={(id, userId) => {
            if (blockSuperAgentWithoutGithub(userId)) return;
            actions.update.mutate({ id, assigneeId: userId ?? undefined });
          }}
          onAutoFix={
            reportsOnly
              ? (item) => {
                  if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID))
                    return;
                  actions.update.mutate({
                    id: item.id,
                    assigneeId: SUPER_AGENT_ASSIGNEE_ID,
                  });
                }
              : undefined
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-16 sm:px-8">
          <div className="mx-auto flex max-w-[820px] flex-col gap-2">
            {visibleItems.map((item) => (
              <ListRow
                key={item.id}
                item={item}
                assignee={
                  item.assigneeId
                    ? memberByUserId.get(item.assigneeId)
                    : undefined
                }
                assignedBy={
                  item.assignedBy
                    ? memberByUserId.get(item.assignedBy)
                    : undefined
                }
                onOpen={() => openTask(item)}
              />
            ))}
          </div>
        </div>
      )}

      <TaskBoardItemDialog
        key={
          modalOpen
            ? (activeItem?.id ?? `new-${createStatus ?? "default"}`)
            : "closed"
        }
        open={modalOpen}
        onClose={closeDialog}
        item={activeItem ?? undefined}
        defaultStatus={createStatus ?? undefined}
        isSaving={actions.create.isPending || actions.update.isPending}
        onSubmit={(input) => {
          if (blockSuperAgentWithoutGithub(input.assigneeId)) {
            closeDialog();
            return;
          }
          if (activeItem) {
            actions.update.mutate({ id: activeItem.id, ...input });
          } else {
            actions.create.mutate(input);
          }
          closeDialog();
        }}
        onDelete={
          activeItem
            ? () => {
                actions.remove.mutate(activeItem.id);
                closeDialog();
              }
            : undefined
        }
        onNewChat={
          activeItem ? () => void startChatFromTask(activeItem) : undefined
        }
        onOpenThread={(thread) => {
          if (!thread.virtualMcpId) return;
          closeDialog();
          setTaskId(thread.threadId, thread.virtualMcpId, {
            main: thread.hasPreview ? "preview" : "board",
          });
        }}
      />

      <ConnectGitHubDialog
        open={connectGithubOpen}
        onOpenChange={setConnectGithubOpen}
      />
    </div>
  );
}

/**
 * Small prompt shown when Auto-fix is used in an org with no GitHub connection.
 * The Super Agent needs GitHub to open a PR, so we connect first. Once the
 * connection lands the card's Auto-fix button works on the next click.
 */
function ConnectGitHubDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { connect, isConnecting } = useConnectApp("deco/mcp-github");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("taskBoard.taskBoard.connectGithubTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("taskBoard.taskBoard.connectGithubDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            onClick={async () => {
              await connect();
              onOpenChange(false);
            }}
            disabled={isConnecting}
            className="gap-2"
          >
            {isConnecting ? (
              <Loading01 size={16} className="animate-spin" />
            ) : (
              <GitHubIcon className="size-4" />
            )}
            {t("taskBoard.taskBoard.connectGithubButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LayoutToggle({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof List;
  label: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("taskBoard.taskBoard.layoutViewAriaLabel", { label })}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

/**
 * `sortOrder` a dragged card should take to land right before `beforeId`
 * within `laneItems` (or at the end when `beforeId` is null) — the midpoint
 * of its new neighbors, so reordering never needs to touch other rows.
 */
function insertSortOrder(
  laneItems: TaskBoardItem[],
  beforeId: string | null,
  draggedId: string,
): number {
  const filtered = laneItems.filter((i) => i.id !== draggedId);
  const beforeIndex = beforeId
    ? filtered.findIndex((i) => i.id === beforeId)
    : -1;
  const insertIndex = beforeIndex === -1 ? filtered.length : beforeIndex;
  const prev = filtered[insertIndex - 1];
  const next = filtered[insertIndex];
  if (prev && next) return (prev.sortOrder + next.sortOrder) / 2;
  if (prev) return prev.sortOrder + 1;
  if (next) return next.sortOrder - 1;
  return 0;
}

function Lanes({
  items,
  members,
  memberByUserId,
  onOpen,
  onCreate,
  onMove,
  onAutoFix,
  onAssign,
}: {
  items: TaskBoardItem[];
  members: Member[];
  memberByUserId: Map<string, Member>;
  onOpen: (item: TaskBoardItem) => void;
  onCreate: (status: TaskBoardItemStatus) => void;
  onMove: (id: string, status: TaskBoardItemStatus, sortOrder: number) => void;
  onAutoFix?: (item: TaskBoardItem) => void;
  onAssign?: (id: string, userId: string | null) => void;
}) {
  const t = useT();
  const [overLane, setOverLane] = useState<TaskBoardItemStatus | null>(null);
  // Which card the dragged one would land before, within `overLane` — null
  // means "at the end of the lane". Drives both the drop math and the
  // insertion-line indicator.
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  // Re-run FLIP whenever a card's lane or ordering changes.
  const signature = items.map((t) => `${t.id}:${t.status}`).join(",");
  useFlipLanes(boardRef, signature);

  return (
    // Scroll container spans the full panel width so the wheel works even when
    // the pointer is in the empty margins on wide monitors. The lane row inside
    // is capped + centered to the same width as the header (so they align), and
    // overflows this row to scroll when it doesn't fit.
    <div
      ref={boardRef}
      className="min-h-0 flex-1 overflow-x-auto overflow-y-auto"
    >
      {/* Padding lives on the capped row (not the scroll container) so its left
          edge matches the header's max-w + px exactly. */}
      <div className="mx-auto flex w-full max-w-[1680px] gap-3 px-4 pt-6 pb-16 sm:px-8">
        {STATUSES.map((status) => {
          const laneItems = items.filter((t) => t.status === status);
          const config = STATUS_CONFIG[status];
          const LaneIcon = config.icon;
          return (
            <div
              key={status}
              onDragOver={(e) => {
                e.preventDefault();
                setOverLane(status);
                // Only reached when not over a card (cards stop propagation),
                // i.e. the empty area below the last card — drop at the end.
                setDropBeforeId(null);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setOverLane(null);
                  setDropBeforeId(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain");
                if (id) {
                  onMove(
                    id,
                    status,
                    insertSortOrder(laneItems, dropBeforeId, id),
                  );
                }
                setOverLane(null);
                setDropBeforeId(null);
              }}
              className={cn(
                "flex w-[300px] shrink-0 flex-col rounded-xl p-1 transition-colors",
                overLane === status && "bg-muted/50",
              )}
            >
              {/* Sticky so the column header stays visible while the cards
                  scroll vertically under it. */}
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-background px-2 py-1.5">
                <LaneIcon
                  size={15}
                  className={cn("shrink-0", config.iconClassName)}
                />
                <span className="text-sm font-medium text-foreground">
                  {t(config.labelKey)}
                </span>
                <span className="rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
                  {laneItems.length}
                </span>
                <button
                  type="button"
                  aria-label={t("taskBoard.taskBoard.newTaskInLaneAriaLabel", {
                    lane: t(config.labelKey),
                  })}
                  title={t("taskBoard.taskBoard.newTaskInLaneTitle", {
                    lane: t(config.labelKey),
                  })}
                  onClick={() => onCreate(status)}
                  className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Plus size={15} />
                </button>
              </div>
              <div className="flex min-h-12 flex-col pt-1">
                {laneItems.map((item) => (
                  <Fragment key={item.id}>
                    <DropDivider
                      show={overLane === status && dropBeforeId === item.id}
                    />
                    <TaskCard
                      item={item}
                      assignee={
                        item.assigneeId
                          ? memberByUserId.get(item.assigneeId)
                          : undefined
                      }
                      assignedBy={
                        item.assignedBy
                          ? memberByUserId.get(item.assignedBy)
                          : undefined
                      }
                      members={members}
                      onOpen={() => onOpen(item)}
                      onAutoFix={onAutoFix ? () => onAutoFix(item) : undefined}
                      onAssign={
                        onAssign
                          ? (userId) => onAssign(item.id, userId)
                          : undefined
                      }
                      onDragOverCard={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOverLane(status);
                        const rect = e.currentTarget.getBoundingClientRect();
                        const before = e.clientY - rect.top < rect.height / 2;
                        if (before) {
                          setDropBeforeId(item.id);
                        } else {
                          const index = laneItems.indexOf(item);
                          setDropBeforeId(laneItems[index + 1]?.id ?? null);
                        }
                      }}
                    />
                  </Fragment>
                ))}
                <DropDivider
                  show={overLane === status && dropBeforeId === null}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Thin line marking where a dragged card will land between two others. */
function DropDivider({ show }: { show: boolean }) {
  return (
    <div className="flex h-3 shrink-0 items-center px-1">
      <div
        className={cn(
          "h-0.5 w-full rounded-full transition-colors",
          show ? "bg-primary/20" : "bg-transparent",
        )}
      />
    </div>
  );
}

function TaskCard({
  item,
  assignee,
  assignedBy,
  members,
  onOpen,
  onAutoFix,
  onAssign,
  onDragOverCard,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  onOpen: () => void;
  onAutoFix?: () => void;
  onAssign?: (userId: string | null) => void;
  onDragOverCard?: (e: DragEvent<HTMLButtonElement>) => void;
}) {
  const t = useT();
  const statusConfig = STATUS_CONFIG[item.status];
  const StatusIcon = statusConfig.icon;
  const lastMessage = primaryThread(item)?.lastMessage;

  const showAutoFix =
    onAutoFix &&
    (item.status === "triage" || item.status === "todo") &&
    item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID;

  return (
    <button
      type="button"
      draggable
      data-flip-id={item.id}
      data-flip-lane={item.status}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={onDragOverCard}
      onClick={onOpen}
      className="group flex cursor-grab flex-col gap-2 rounded-xl bg-card px-3 py-2.5 text-left card-shadow transition-colors will-change-transform hover:bg-accent/60 active:cursor-grabbing"
      title={item.title}
    >
      <div className="flex items-start gap-2">
        <StatusIcon
          size={16}
          className={cn("mt-px shrink-0", statusConfig.iconClassName)}
        />
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground line-clamp-2">
          {item.title}
        </span>
        <AssigneeDisplay
          item={item}
          assignee={assignee}
          assignedBy={assignedBy}
          members={members}
          onAssign={onAssign}
        />
      </div>

      {lastMessage && (
        <p className="line-clamp-2 pl-6 text-xs leading-snug text-muted-foreground">
          {lastMessage}
        </p>
      )}

      {(isTaskBlocked(item) ||
        item.priority !== "none" ||
        Boolean(item.dueDate)) && (
        <div className="flex flex-wrap items-center gap-1.5 pl-6">
          {isTaskBlocked(item) && <BlockedBadge />}
          {item.priority !== "none" && (
            <PriorityPill priority={item.priority} />
          )}
          {item.dueDate && <DueDatePill iso={item.dueDate} />}
        </div>
      )}

      {showAutoFix && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAutoFix();
          }}
          className="flex items-center gap-1.5 self-end rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Lightning01 size={12} />
          {t("taskBoard.taskBoard.autoFix")}
        </button>
      )}
    </button>
  );
}

function ListRow({
  item,
  assignee,
  assignedBy,
  onOpen,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  onOpen: () => void;
}) {
  const config = STATUS_CONFIG[item.status];
  const StatusIcon = config.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-left card-shadow transition-colors hover:bg-accent/60"
    >
      <StatusIcon size={16} className={cn("shrink-0", config.iconClassName)} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {item.title}
      </span>
      {isTaskBlocked(item) && <BlockedBadge />}
      {item.priority !== "none" && (
        <span className="hidden sm:inline-flex">
          <PriorityPill priority={item.priority} />
        </span>
      )}
      {item.dueDate && (
        <span className="hidden sm:inline-flex">
          <DueDatePill iso={item.dueDate} />
        </span>
      )}
      <AssigneeDisplay
        item={item}
        assignee={assignee}
        assignedBy={assignedBy}
      />
      <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">
        {formatTimeAgo(new Date(item.createdAt))}
      </span>
    </button>
  );
}
