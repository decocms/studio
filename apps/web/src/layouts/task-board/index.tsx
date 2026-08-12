/**
 * Task board (`?main=board`) — the org's own board of tasks (title,
 * description, status, priority, assignee), independent of chat threads.
 * Rendered as a main-panel overlay tab; there is no standalone route.
 */

import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getInitials } from "@/lib/get-initials";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  Calendar,
  ChevronRight,
  Columns03,
  DotsHorizontal,
  HelpCircle,
  Lightning01,
  List,
  Loading01,
  Plus,
  RefreshCw01,
  UserPlus01,
  X,
} from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { QaAgentIcon } from "@/components/qa-agent-icon";
import { CodeReviewerIcon } from "@/components/code-reviewer-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  getWellKnownDecopilotVirtualMCP,
  useConnections,
  useProjectContext,
} from "@/sdk";
import {
  getRepoScope,
  listRepoScopeLabels,
} from "@decocms/shared/github-repo-scope";
import { GitHubRepoPicker } from "@/components/github-repo-picker";
import { useConnectApp } from "@/hooks/use-connect-app";
import { useMembers } from "@/hooks/use-members";
import {
  useTaskBoardItemActions,
  useTaskBoardItems,
} from "@/hooks/use-task-board-items";
import { formatTimeAgo } from "@/lib/format-time";
import {
  insertSortOrder,
  isReviewerThreadTitle,
  isTaskBlocked,
  HIDDEN_STATUSES,
  primaryThread,
  reviewerThreads,
  PRIORITIES,
  PRIORITY_CONFIG,
  runSortOrders,
  statusIconClassName,
  STATUS_CONFIG,
  STATUSES,
  SUPER_AGENT_ASSIGNEE_ID,
  tagDotColor,
  type TaskBoardItem,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type TaskBoardItemTag,
  type TaskBoardItemThread,
  type Member,
} from "./config";
import { useTags } from "@/hooks/use-tags";
import { usePreferences } from "@/hooks/use-preferences";
import {
  TaskBoardItemDialog,
  threadStatusStyle,
  toEndOfDayIso,
} from "./task-dialog";
import { AssigneePickerContent } from "./assignee-picker";
import { SubscriptionPaywallDialog } from "./subscription-paywall-dialog";
import { RerunDialog } from "./rerun-dialog";
import { subscriptionErrorKind } from "@/components/task-board/is-subscription-error";
import { isReportsTask, type ReviewerKind } from "@decocms/shared/task-board";
import { useFlipLanes } from "./use-flip-lanes";
import { Calendar as DayPickerCalendar } from "@decocms/ui/components/calendar.tsx";
import { buildTaskChatContext } from "./build-task-chat-context";
import { useStudioTools } from "@/lib/studio-tools";
import {
  EMPTY_FILTERS,
  TaskFiltersBar,
  TaskFiltersDrawer,
  taskMatchesFilters,
  type TaskFilters,
} from "./task-filters";
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

function TagPill({ tag }: { tag: TaskBoardItemTag }) {
  return (
    <span className={PILL}>
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: tagDotColor(tag.color) }}
      />
      {tag.name}
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
          title={t("taskBoard.taskBoard.assignButton")}
          aria-label={t("taskBoard.taskBoard.assignButton")}
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
  const { data: orgTags = [] } = useTags();
  const actions = useTaskBoardItemActions();
  const reportsOnly = useReportsOnly();
  // Handing a task to the Super Agent makes it open a PR — so it needs at
  // least one repo imported (a repo-scoped mcp-github connection; the bare
  // org-level connection has no `repoScope` and isn't loadable). Every path that
  // assigns to the Super Agent (Auto-fix, the lane assignee picker, the task
  // dialog) prompts to connect + pick a repo instead of enqueueing a run that
  // has nothing to load.
  // Mirrors `load_repo`'s `selectLoadableRepos` (apps/api): the Super Agent's
  // built-in loads ANY active repo-scoped `mcp-github` connection — org-shared
  // OR per-agent (e.g. a repo imported by a Code Agent). So an existing
  // per-agent connection already satisfies this; don't force a fresh connect.
  const githubConnections = useConnections({ slug: "mcp-github" }) ?? [];
  const hasRepo = githubConnections.some(
    (c) => c.status === "active" && getRepoScope(c) !== null,
  );
  // Repo filter options: distinct `owner/name` repos the org can reach.
  const repos = listRepoScopeLabels(githubConnections);
  const [connectGithubOpen, setConnectGithubOpen] = useState(false);
  // Connecting only grants a broad org-level GitHub connection — Auto-fix
  // still needs a repo imported (see `hasRepo`), so once connected we chain
  // straight into the repo picker.
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  // Returns true if the assignment was blocked (connect prompt opened) so the
  // caller stops before dispatching.
  const blockSuperAgentWithoutGithub = (
    assigneeId: string | null | undefined,
  ) => {
    if (assigneeId === SUPER_AGENT_ASSIGNEE_ID && !hasRepo) {
      setConnectGithubOpen(true);
      return true;
    }
    return false;
  };
  // Set when delegating to the Super Agent (dialog submit or the lane/card
  // assignee picker) is rejected with a `[SUBSCRIPTION_REQUIRED]` error — see
  // `subscriptionErrorKind`'s 3 cases. Both delegation paths funnel through
  // `actions.update`, so a single per-call `onError` here covers both.
  const [subscriptionPaywall, setSubscriptionPaywall] =
    useState<ReturnType<typeof subscriptionErrorKind>>(null);
  const onDelegateError = (err: Error) => {
    const kind = subscriptionErrorKind(err);
    if (kind) setSubscriptionPaywall(kind);
  };
  // The task awaiting a re-run confirmation, or null. A re-run supersedes the
  // task's live run, so it is confirmed rather than fired on click.
  // One entry for a card's own Re-run, many for a selection.
  const [rerunTargets, setRerunTargets] = useState<TaskBoardItem[]>([]);
  const confirmRerun = () => {
    if (rerunTargets.length === 0) return;
    // Same GitHub precondition as delegating: the run is expected to open a PR.
    if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID)) {
      setRerunTargets([]);
      return;
    }
    // ponytail: fire-and-forget per task, like every other bulk action here —
    // the board reconciles from the invalidation each one triggers.
    for (const target of rerunTargets)
      actions.rerun.mutate(
        { id: target.id },
        { onError: (err) => onDelegateError(err as Error) },
      );
    setRerunTargets([]);
    clearSelection();
  };
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as Member[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  const [layout, setLayout] = useState<Layout>("board");
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAllInLane = (status: TaskBoardItemStatus) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of visibleItems)
        if (item.status === status) next.add(item.id);
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());
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
  // Deep link: `?main=board&task=<id>` opens that task's modal (from a linked
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
        to: ".",
        search: ({ task: _task, ...rest }: Record<string, unknown>) => rest,
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
    // Keep the URL shareable regardless of how the modal was opened.
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, task: item.id }),
      replace: true,
    });
  };

  // Opening a card always opens the task modal. The modal's activity area is
  // what navigates into the run's chat (see onOpenThread below).
  const openTask = openEdit;

  // The task the modal is editing — a locally-opened card, or the deep-linked
  // one. Resolve the LIVE row from the SSE-patched list by id (falling back to
  // the click-time snapshot if it's momentarily absent) so threads/status
  // linked while the modal is open — e.g. the QA Agent session handed off
  // mid-view — flow in without reopening. The snapshot alone would freeze the
  // item at open time.
  const activeItem =
    (editingItem && items.find((i) => i.id === editingItem.id)) ??
    editingItem ??
    deepLinkItem;
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
    <div className="relative flex min-h-0 flex-1 flex-col">
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
                  tags={orgTags}
                  repos={repos}
                  onChange={setFilters}
                />
              </div>
              <div className="hidden sm:block">
                <TaskFiltersBar
                  filters={filters}
                  members={members}
                  tags={orgTags}
                  repos={repos}
                  onChange={setFilters}
                />
              </div>
            </>
          )}

          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-muted p-0.5">
              <LayoutToggle
                active={layout === "list"}
                onClick={() => {
                  setLayout("list");
                  // Selection is a board-only concept (List has no way to see
                  // or change which cards are selected) — leaving it wedges
                  // the floating bulk-action bar on-screen, operating on a
                  // selection the user can no longer see.
                  clearSelection();
                }}
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
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAllInLane={selectAllInLane}
          onOpen={openTask}
          onCreate={openCreateInLane}
          onMove={(ids, status, sortOrder) => {
            // Cards dragged together land as a consecutive run ending at the
            // drop point, keeping `ids` order.
            const orders = runSortOrders(sortOrder, ids.length);
            ids.forEach((id, i) =>
              actions.update.mutate({
                id,
                status,
                sortOrder: orders[i]!,
              }),
            );
          }}
          onAssign={(id, userId) => {
            if (blockSuperAgentWithoutGithub(userId)) return;
            // `userId` is `null` for "Unassigned" — `?? undefined` used to
            // coalesce that into "field not provided", silently no-opping the
            // unassign since TASK_BOARD_ITEM_UPDATE treats undefined as
            // unchanged. `assigneeId` is nullable in the update schema, so
            // pass `userId` through as-is.
            actions.update.mutate(
              { id, assigneeId: userId },
              { onError: onDelegateError },
            );
          }}
          onAutoFix={(item) => {
            if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID)) return;
            actions.update.mutate(
              {
                id: item.id,
                assigneeId: SUPER_AGENT_ASSIGNEE_ID,
              },
              { onError: onDelegateError },
            );
          }}
          onRerun={(item) => setRerunTargets([item])}
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
            // Reports-generated tasks reject a write touching title/
            // description/priority (their content is owned by the reports
            // sync) — the dialog locks those fields, but still round-trips
            // their unchanged values here, so drop them instead of sending a
            // payload the server would 500 on. Board interactions
            // (status/assignee/dueDate/tagIds) always go through.
            const { title, description, priority, ...boardFields } = input;
            const contentFields = isReportsTask(activeItem)
              ? {}
              : { title, description, priority };
            actions.update.mutate(
              { id: activeItem.id, ...boardFields, ...contentFields },
              { onError: onDelegateError },
            );
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
        onAutoFix={
          activeItem
            ? () => {
                if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID))
                  return;
                actions.update.mutate(
                  {
                    id: activeItem.id,
                    assigneeId: SUPER_AGENT_ASSIGNEE_ID,
                  },
                  { onError: onDelegateError },
                );
                closeDialog();
              }
            : undefined
        }
        onRerun={
          activeItem
            ? () => {
                // Confirm in the shared dialog rather than firing from here —
                // the card path does the same, so the takeover warning has one
                // home. Closing the task dialog first keeps them unstacked.
                closeDialog();
                setRerunTargets([activeItem]);
              }
            : undefined
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
        onConnected={() => setRepoPickerOpen(true)}
      />
      <GitHubRepoPicker
        mode="connection"
        open={repoPickerOpen}
        onOpenChange={setRepoPickerOpen}
      />

      <SubscriptionPaywallDialog
        kind={subscriptionPaywall}
        onOpenChange={(open) => !open && setSubscriptionPaywall(null)}
      />

      <RerunDialog
        items={rerunTargets}
        pending={actions.rerun.isPending}
        onOpenChange={(open) => !open && setRerunTargets([])}
        onConfirm={confirmRerun}
      />

      {selectedIds.size > 0 && (
        <SelectionBar
          count={selectedIds.size}
          members={members}
          onMoveTo={(status) => {
            for (const id of selectedIds) actions.update.mutate({ id, status });
            clearSelection();
          }}
          onSetPriority={(priority) => {
            for (const id of selectedIds)
              actions.update.mutate({ id, priority });
            clearSelection();
          }}
          onAddTag={(tagId) => {
            for (const id of selectedIds) {
              const item = items.find((i) => i.id === id);
              if (!item) continue;
              const tagIds = item.tags.map((tag) => tag.id);
              if (tagIds.includes(tagId)) continue;
              actions.update.mutate({ id, tagIds: [...tagIds, tagId] });
            }
            clearSelection();
          }}
          onAssign={(userId) => {
            if (blockSuperAgentWithoutGithub(userId)) return;
            for (const id of selectedIds)
              actions.update.mutate(
                { id, assigneeId: userId },
                { onError: onDelegateError },
              );
            clearSelection();
          }}
          onSetDueDate={(date) => {
            const dueDate = toEndOfDayIso(date);
            for (const id of selectedIds)
              actions.update.mutate({ id, dueDate });
            clearSelection();
          }}
          onAutoFix={
            selectedIds.size > 0 &&
            Array.from(selectedIds).every((id) => {
              const item = items.find((i) => i.id === id);
              return (
                item &&
                (item.status === "triage" || item.status === "todo") &&
                item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID
              );
            })
              ? () => {
                  if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID))
                    return;
                  for (const id of selectedIds)
                    actions.update.mutate(
                      { id, assigneeId: SUPER_AGENT_ASSIGNEE_ID },
                      { onError: onDelegateError },
                    );
                  clearSelection();
                }
              : undefined
          }
          onRerun={
            // Same eligibility as a card's own Re-run button: delegated to the
            // Super Agent and not Done. Offered only when every selected card
            // qualifies, so the action never silently skips part of a selection.
            (() => {
              const targets = Array.from(selectedIds).flatMap((id) => {
                const item = items.find((i) => i.id === id);
                return item ? [item] : [];
              });
              return targets.length === selectedIds.size &&
                targets.every(
                  (item) =>
                    item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
                    item.status !== "done",
                )
                ? () => setRerunTargets(targets)
                : undefined;
            })()
          }
          onDelete={() => {
            actions.removeMany.mutate(Array.from(selectedIds));
            clearSelection();
          }}
          onClear={clearSelection}
        />
      )}
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
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the connect attempt settles, success or failure — the
   *  caller (the repo picker) has its own auto-install fallback either way. */
  onConnected: () => void;
}) {
  const t = useT();
  const { connect, isConnecting } = useConnectApp("deco/mcp-github");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="flex h-28 items-center justify-center bg-gradient-to-br from-muted via-muted to-accent">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-foreground text-background shadow-sm">
            <GitHubIcon className="size-7" />
          </div>
        </div>
        <div className="flex flex-col gap-4 p-6">
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
                onConnected();
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
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Floating pill toolbar that appears once at least one card is selected —
 * count, a bulk "Actions" menu (move / tag / priority / delete), a quick
 * "move to" shortcut, and a close button that clears the selection.
 */
function SelectionBar({
  count,
  members,
  onMoveTo,
  onSetPriority,
  onAddTag,
  onAssign,
  onSetDueDate,
  onAutoFix,
  onRerun,
  onDelete,
  onClear,
}: {
  count: number;
  members: Member[];
  onMoveTo: (status: TaskBoardItemStatus) => void;
  onSetPriority: (priority: TaskBoardItemPriority) => void;
  onAddTag: (tagId: string) => void;
  onAssign: (userId: string | null) => void;
  onSetDueDate: (date: Date) => void;
  /** Bulk-assign to the Super Agent — only offered when every selected card
   *  is still in Backlog/To Do (see `TaskBoardPage`). */
  onAutoFix?: () => void;
  /** Bulk re-run — only offered when every selected card is a Super Agent card
   *  that isn't Done (see `TaskBoardPage`). */
  onRerun?: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const { data: orgTags = [] } = useTags();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-background px-3 py-2 card-shadow">
        <span className="pl-1 text-sm font-medium text-foreground">
          {t("taskBoard.taskBoard.selectedCount", { count })}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {t("taskBoard.taskBoard.actionsButton")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.moveToButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {STATUSES.map((status) => (
                  <DropdownMenuItem
                    key={status}
                    onClick={() => onMoveTo(status)}
                  >
                    {t(STATUS_CONFIG[status].labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.changePriorityButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {PRIORITIES.map((priority) => (
                  <DropdownMenuItem
                    key={priority}
                    onClick={() => onSetPriority(priority)}
                  >
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        PRIORITY_CONFIG[priority].dotClassName,
                      )}
                    />
                    {t(PRIORITY_CONFIG[priority].labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.assignButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56 p-0">
                <AssigneePickerContent members={members} onSelect={onAssign} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.dueDateButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-auto p-0">
                <DayPickerCalendar
                  mode="single"
                  onSelect={(date) => date && onSetDueDate(date)}
                  initialFocus
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {orgTags.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {t("taskBoard.taskBoard.addTagButton")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {orgTags.map((tag) => (
                    <DropdownMenuItem
                      key={tag.id}
                      onClick={() => onAddTag(tag.id)}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: tagDotColor(tag.color) }}
                      />
                      {tag.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              {t("taskBoard.taskBoard.deleteSelectedButton")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {onAutoFix && (
          <button
            type="button"
            onClick={onAutoFix}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Lightning01 size={14} />
            {t("taskBoard.taskBoard.autoFix")}
          </button>
        )}

        {onRerun && (
          <button
            type="button"
            onClick={onRerun}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <RefreshCw01 size={14} />
            {t("taskBoard.taskBoard.rerun")}
          </button>
        )}

        <button
          type="button"
          aria-label={t("taskBoard.taskBoard.clearSelectionButton")}
          title={t("taskBoard.taskBoard.clearSelectionButton")}
          onClick={onClear}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
    </div>
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

/** Prefix for a lane's own droppable id, so it can't collide with a card id. */
const LANE_DROPPABLE_PREFIX = "lane:";

/** Where a card sits locally: while a drag is in flight, and then until the
 *  server's optimistic patch catches up. */
interface Placement {
  status: TaskBoardItemStatus;
  sortOrder: number;
}

/** Bits `useSortable` hands back that have to land on the card's own element
 *  for it to be draggable. Derived from the hook so there's no deep import. */
type SortableBindings = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners"
>;

function bySortOrder(a: TaskBoardItem, b: TaskBoardItem) {
  return a.sortOrder - b.sortOrder;
}

function Lanes({
  items,
  members,
  memberByUserId,
  selectedIds,
  onToggleSelect,
  onSelectAllInLane,
  onOpen,
  onCreate,
  onMove,
  onAutoFix,
  onRerun,
  onAssign,
}: {
  items: TaskBoardItem[];
  members: Member[];
  memberByUserId: Map<string, Member>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAllInLane: (status: TaskBoardItemStatus) => void;
  onOpen: (item: TaskBoardItem) => void;
  onCreate: (status: TaskBoardItemStatus) => void;
  onMove: (
    ids: string[],
    status: TaskBoardItemStatus,
    sortOrder: number,
  ) => void;
  onAutoFix?: (item: TaskBoardItem) => void;
  onRerun?: (item: TaskBoardItem) => void;
  onAssign?: (id: string, userId: string | null) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Cards that just landed from a drop — they get the settle animation. Cleared
  // on drag start so dropping the same card twice replays it (a CSS animation
  // only re-runs when the class is removed and re-added).
  const [landedIds, setLandedIds] = useState<string[]>([]);
  // Local placement overrides, doing two jobs with one mechanism:
  //   1. Live preview — while dragging across lanes the card is rendered into
  //      the lane under the cursor, which is what makes dnd-kit's sortable
  //      strategy open a gap there.
  //   2. Bridge — after the drop they hold the new placement until the
  //      mutation's optimistic cache patch lands, so a card never flicks back
  //      to its old lane for a frame.
  // Entries retire themselves once `items` reports the same placement.
  const [overrides, setOverrides] = useState<Map<string, Placement>>(new Map());
  const [preferences, setPreferences] = usePreferences();
  const boardRef = useRef<HTMLDivElement>(null);

  // A plain mouse wheel only emits vertical deltas, so on a board that overflows
  // sideways the columns off-screen to the right are unreachable without a
  // trackpad (two-finger swipe) or Shift+wheel — neither of which a mouse user
  // has. Translate a vertical wheel into horizontal board scroll, but only when
  // the pointer isn't over a lane that can still absorb that scroll itself, so
  // scrolling a column's cards keeps working. Registered natively (not via
  // React's passive onWheel) so preventDefault can suppress the browser's own
  // vertical scroll/overscroll; React 19 ref cleanup unregisters it.
  const attachBoard = (node: HTMLDivElement | null) => {
    boardRef.current = node;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      // Trackpad / Shift+wheel already produce a horizontal delta — let the
      // browser handle those natively.
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      if (node.scrollWidth <= node.clientWidth) return;
      // Walk up from the pointer target: if a lane under it can still scroll
      // vertically in this direction, that's what the wheel is for.
      for (
        let el = event.target as HTMLElement | null;
        el && el !== node;
        el = el.parentElement
      ) {
        if (el.hasAttribute("data-lane-scroll")) {
          const hasRoom =
            event.deltaY < 0
              ? el.scrollTop > 0
              : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
          if (hasRoom) return;
          break;
        }
      }
      event.preventDefault();
      const factor =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? node.clientWidth
            : 1;
      node.scrollLeft += event.deltaY * factor;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      boardRef.current = null;
      node.removeEventListener("wheel", onWheel);
    };
  };

  const placed =
    overrides.size > 0
      ? items.map((item) => {
          const override = overrides.get(item.id);
          return override ? { ...item, ...override } : item;
        })
      : items;

  // Retire settled overrides during render — React's supported "adjust state
  // while rendering" path, so no frame paints with a stale override and this
  // needs no effect (banned in this codebase).
  if (overrides.size > 0 && !activeId) {
    const settled = [...overrides].filter(([id, placement]) => {
      const server = items.find((item) => item.id === id);
      return (
        server?.status === placement.status &&
        server.sortOrder === placement.sortOrder
      );
    });
    if (settled.length > 0) {
      setOverrides((prev) => {
        const next = new Map(prev);
        for (const [id] of settled) next.delete(id);
        return next;
      });
    }
  }

  // Animates lane changes that land without a drag (agent auto-move, the bulk
  // "Move to" action) — disabled while `activeId` is set so it stays out of
  // dnd-kit's own motion during an actual drag.
  useFlipLanes(
    boardRef,
    placed.map((item) => `${item.id}:${item.status}`).join(","),
    activeId === null,
  );

  const laneItems = (status: TaskBoardItemStatus) =>
    placed.filter((item) => item.status === status).sort(bySortOrder);

  /** Shown-again lanes persist per person (localStorage), so pulling Archived
   *  onto the board survives a reload. */
  const hiddenLanes = HIDDEN_STATUSES.filter(
    (status) => !preferences.shownTaskBoardLanes.includes(status),
  );
  const boardLanes = STATUSES.filter((status) => !hiddenLanes.includes(status));
  const setLaneShown = (status: TaskBoardItemStatus, shown: boolean) =>
    setPreferences((prev) => ({
      ...prev,
      shownTaskBoardLanes: shown
        ? [...prev.shownTaskBoardLanes, status]
        : prev.shownTaskBoardLanes.filter((s) => s !== status),
    }));

  /** The lane a drop target belongs to: a lane's own droppable, or the lane of
   *  the card being hovered. Resolved against `placed` rather than dnd-kit's
   *  `over.data`, which is a ref and can't be read during render. */
  const laneOf = (overId: string | number | undefined) => {
    if (overId === undefined) return null;
    const id = String(overId);
    if (id.startsWith(LANE_DROPPABLE_PREFIX)) {
      const status = id.slice(LANE_DROPPABLE_PREFIX.length);
      return STATUSES.find((candidate) => candidate === status) ?? null;
    }
    return placed.find((item) => item.id === id)?.status ?? null;
  };

  // A card inside a multi-selection drags the whole selection, grabbed card
  // first so it leads the run and the others follow in order.
  const groupOf = (id: string) =>
    selectedIds.has(id) && selectedIds.size > 1
      ? [id, ...Array.from(selectedIds).filter((other) => other !== id)]
      : [id];

  const place = (ids: string[], status: TaskBoardItemStatus, slot: number) => {
    const orders = runSortOrders(slot, ids.length);
    setOverrides((prev) => {
      const next = new Map(prev);
      ids.forEach((id, i) => next.set(id, { status, sortOrder: orders[i]! }));
      return next;
    });
  };

  const sensors = useSensors(
    // Distance threshold so a plain click (open the task) and a shift-click
    // (toggle selection) still work — the drag only engages once the pointer
    // actually travels.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragOver = (event: DragOverEvent) => {
    const id = String(event.active.id);
    const lane = laneOf(event.over?.id);
    const current = placed.find((item) => item.id === id);
    if (!lane || !current || current.status === lane) return;
    // Crossed into a different lane: preview the group there so the gap opens
    // under the cursor. Reordering *within* a lane needs no override — the
    // sortable strategy already shifts the neighbours.
    const ids = groupOf(id);
    const overId = String(event.over?.id ?? "");
    const target = laneItems(lane).filter((item) => !ids.includes(item.id));
    place(
      ids,
      lane,
      insertSortOrder(
        target,
        overId.startsWith(LANE_DROPPABLE_PREFIX) ? null : overId,
        id,
      ),
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const id = String(event.active.id);
    setActiveId(null);
    const lane =
      laneOf(event.over?.id) ?? placed.find((item) => item.id === id)?.status;
    if (!lane) {
      setOverrides(new Map());
      return;
    }
    const ids = groupOf(id);
    // `placed` already shows the arrangement the user is looking at (a
    // cross-lane hover was applied in handleDragOver), so the landing slot is
    // just the sortable reorder within `lane`.
    const laneNow = laneItems(lane);
    const overId = String(event.over?.id ?? "");
    const from = laneNow.findIndex((item) => item.id === id);
    const to = overId.startsWith(LANE_DROPPABLE_PREFIX)
      ? laneNow.length - 1
      : laneNow.findIndex((item) => item.id === overId);
    const reordered =
      from === -1 || to === -1 ? laneNow : arrayMove(laneNow, from, to);

    // Dropped back exactly where it started — skip the write entirely.
    const serverOrder = items
      .filter((item) => item.status === lane)
      .sort(bySortOrder)
      .map((item) => item.id)
      .join();
    if (serverOrder === reordered.map((item) => item.id).join()) {
      setOverrides(new Map());
      return;
    }

    // The first non-group card after the landing point defines the slot; group
    // members are excluded so they can't skew their own midpoint.
    const after = reordered
      .slice(reordered.findIndex((item) => item.id === id) + 1)
      .find((item) => !ids.includes(item.id));
    const slot = insertSortOrder(
      laneNow.filter((item) => !ids.includes(item.id)),
      after?.id ?? null,
      id,
    );
    place(ids, lane, slot);
    setLandedIds(ids);
    onMove(ids, lane, slot);
  };

  const activeItem = activeId
    ? placed.find((item) => item.id === activeId)
    : null;
  const activeGroup = activeId ? groupOf(activeId) : [];

  return (
    <DndContext
      sensors={sensors}
      // Corners beat centers across lanes: a tall card's center can sit outside
      // the column the pointer is actually over.
      collisionDetection={closestCorners}
      onDragStart={(event: DragStartEvent) => {
        setActiveId(String(event.active.id));
        setLandedIds([]);
      }}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setOverrides(new Map());
      }}
    >
      {/* Scroll container spans the full panel width so the wheel works even
          when the pointer is in the empty margins on wide monitors. */}
      <div ref={attachBoard} className="min-h-0 flex-1 overflow-x-auto">
        {/* Padding lives on the capped row (not the scroll container) so its
            left edge matches the header's max-w + px exactly. Bottom breathing
            room is handled per-lane by each column's own scrollable div — a pb
            here would eat into this row's h-full and cut every column short,
            since it no longer wraps a single page-level scroll. */}
        <div className="mx-auto flex h-full w-full max-w-[1680px] gap-3 px-4 pt-6 sm:px-8">
          {boardLanes.map((status) => (
            <Lane
              key={status}
              status={status}
              items={laneItems(status)}
              members={members}
              memberByUserId={memberByUserId}
              selectedIds={selectedIds}
              // Highlight the lane the drag currently sits in. Derived from the
              // preview rather than `useDroppable`'s `isOver`, which goes false
              // whenever a card (not the lane) is the drop target and would
              // strobe the background.
              isTarget={activeItem?.status === status}
              hiddenIds={activeGroup}
              landedIds={landedIds}
              onToggleSelect={onToggleSelect}
              onSelectAllInLane={onSelectAllInLane}
              onOpen={onOpen}
              onCreate={onCreate}
              onAutoFix={onAutoFix}
              onRerun={onRerun}
              onAssign={onAssign}
              onHide={
                HIDDEN_STATUSES.includes(status)
                  ? () => setLaneShown(status, false)
                  : undefined
              }
            />
          ))}
          {hiddenLanes.length > 0 && (
            <HiddenLanes
              statuses={hiddenLanes}
              countOf={(status) => laneItems(status).length}
              onShow={(status) => setLaneShown(status, true)}
            />
          )}
        </div>
      </div>
      {/* Portal to body so the overlay's `position: fixed` resolves against the
          viewport rather than the workspace PanelCard's transformed containing
          block (which would offset the card from the cursor). */}
      {createPortal(
        // No drop animation: because the lane opens a live gap under the
        // cursor, the card's final slot IS where you released it — measured at
        // ~10px of travel on a normal drop, so any flight here is invisible
        // work. The landing is animated on the card itself instead (see
        // `landed` / `animate-card-land`), which reads regardless of distance.
        <DragOverlay dropAnimation={null}>
          {activeItem && (
            // Matches the lane's card width (w-[300px] column minus the
            // scroll container's px-1) — outside the lane, nothing else
            // constrains the card's width, so it would shrink to its content.
            <div className="relative w-[292px] cursor-grabbing">
              <TaskCard
                item={activeItem}
                assignee={
                  activeItem.assigneeId
                    ? memberByUserId.get(activeItem.assigneeId)
                    : undefined
                }
                assignedBy={
                  activeItem.assignedBy
                    ? memberByUserId.get(activeItem.assignedBy)
                    : undefined
                }
                selected={selectedIds.has(activeItem.id)}
                onOpen={() => {}}
                className="w-full shadow-lg"
              />
              {activeGroup.length > 1 && (
                <span className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[11px] font-semibold text-background">
                  {activeGroup.length}
                </span>
              )}
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/** The board's tail: lanes that don't get a column until asked for. `<details>`
 *  gives the collapse (closed by default) without any state of its own. */
function HiddenLanes({
  statuses,
  countOf,
  onShow,
}: {
  statuses: TaskBoardItemStatus[];
  countOf: (status: TaskBoardItemStatus) => number;
  onShow: (status: TaskBoardItemStatus) => void;
}) {
  const t = useT();
  return (
    <details className="group h-full w-[300px] shrink-0 py-1">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        {t("taskBoard.taskBoard.hiddenColumns")}
      </summary>
      <div className="flex flex-col gap-2 px-1 pt-1">
        {statuses.map((status) => {
          const config = STATUS_CONFIG[status];
          const LaneIcon = config.icon;
          return (
            <div
              key={status}
              data-hidden-lane={status}
              className="flex items-center gap-2 rounded-xl bg-background px-3 py-2.5 card-shadow"
            >
              <LaneIcon
                size={15}
                className={cn("shrink-0", config.iconClassName)}
              />
              <span className="text-sm font-medium text-foreground">
                {t(config.labelKey)}
              </span>
              <span className="ml-auto text-[11px] font-medium text-muted-foreground">
                {countOf(status)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("taskBoard.taskBoard.laneMenuAriaLabel", {
                      lane: t(config.labelKey),
                    })}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <DotsHorizontal size={15} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onShow(status)}>
                    {t("taskBoard.taskBoard.showColumn")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function Lane({
  status,
  items,
  members,
  memberByUserId,
  selectedIds,
  isTarget,
  hiddenIds,
  landedIds,
  onToggleSelect,
  onSelectAllInLane,
  onOpen,
  onCreate,
  onAutoFix,
  onRerun,
  onAssign,
  onHide,
}: {
  status: TaskBoardItemStatus;
  items: TaskBoardItem[];
  members: Member[];
  memberByUserId: Map<string, Member>;
  selectedIds: Set<string>;
  isTarget: boolean;
  /** Cards riding in the DragOverlay — held in the layout as gaps. */
  hiddenIds: string[];
  /** Cards that just landed from a drop — they play the settle animation. */
  landedIds: string[];
  onToggleSelect: (id: string) => void;
  onSelectAllInLane: (status: TaskBoardItemStatus) => void;
  onOpen: (item: TaskBoardItem) => void;
  onCreate: (status: TaskBoardItemStatus) => void;
  onAutoFix?: (item: TaskBoardItem) => void;
  onRerun?: (item: TaskBoardItem) => void;
  onAssign?: (id: string, userId: string | null) => void;
  /** Present only for a hidden-by-default lane, which can be put back away. */
  onHide?: () => void;
}) {
  const t = useT();
  const config = STATUS_CONFIG[status];
  const LaneIcon = config.icon;
  // The lane's own droppable covers the empty space below the last card, so an
  // empty lane (and the area past the end of a short one) still takes a drop.
  const { setNodeRef } = useDroppable({
    id: `${LANE_DROPPABLE_PREFIX}${status}`,
  });

  return (
    <div
      // Stable hook for e2e drag specs — lane columns are otherwise only
      // identifiable by their localized label or utility classes.
      data-lane={status}
      className={cn(
        "flex h-full w-[300px] shrink-0 flex-col rounded-xl py-1 transition-colors",
        isTarget && "bg-muted/50",
      )}
    >
      {/* Sticky so the column header stays visible while the cards scroll
          vertically under it — needs an opaque bg for that to hide scrolled-
          under cards, so it tracks the lane's own highlight color (solid,
          since bg-muted/50 would let cards show through) rather than a fixed
          one that'd seam against it while a drag is over the lane. */}
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-2 px-2 py-1.5 transition-colors",
          isTarget ? "bg-muted" : "bg-background",
        )}
      >
        {/* Static in the header — unlike the card's own status icon, this
            one isn't tied to a specific task, so spinning it reads as the
            whole lane being "busy" rather than as in-progress work. */}
        <LaneIcon
          size={15}
          className={cn(
            "shrink-0",
            config.iconClassName.replace(/\banimate-\S+\b/g, "").trim(),
          )}
        />
        <span className="text-sm font-medium text-foreground">
          {t(config.labelKey)}
        </span>
        <span className="rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
          {items.length}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("taskBoard.taskBoard.laneMenuAriaLabel", {
                lane: t(config.labelKey),
              })}
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <DotsHorizontal size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onSelectAllInLane(status)}>
              {t("taskBoard.taskBoard.selectAllInLane")}
            </DropdownMenuItem>
            {onHide && (
              <DropdownMenuItem onClick={onHide}>
                {t("taskBoard.taskBoard.hideColumn")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={t("taskBoard.taskBoard.newTaskInLaneAriaLabel", {
            lane: t(config.labelKey),
          })}
          title={t("taskBoard.taskBoard.newTaskInLaneTitle", {
            lane: t(config.labelKey),
          })}
          onClick={() => onCreate(status)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus size={15} />
        </button>
      </div>
      {/* px-1 so each card's shadow has room inside the scrollport — an
          overflow-y container clips the x-axis too, which would clip a FLIP-
          animated card mid-flight between lanes (see `use-flip-lanes`,
          keyed off `data-lane-scroll`). */}
      <div
        ref={setNodeRef}
        data-lane-scroll={status}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 pt-1 pb-16 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1"
      >
        <SortableContext
          items={items.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          {items.map((item) => (
            <SortableTaskCard
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
              members={members}
              selected={selectedIds.has(item.id)}
              hidden={hiddenIds.includes(item.id)}
              landed={landedIds.includes(item.id)}
              onToggleSelect={() => onToggleSelect(item.id)}
              onOpen={() => onOpen(item)}
              onAutoFix={onAutoFix ? () => onAutoFix(item) : undefined}
              onRerun={onRerun ? () => onRerun(item) : undefined}
              onAssign={
                onAssign ? (userId) => onAssign(item.id, userId) : undefined
              }
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/** A card in a lane. `useSortable` supplies the transform that slides it aside
 *  to open a gap, and the transition that animates it into place. */
function SortableTaskCard({
  item,
  hidden,
  landed,
  ...props
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  selected?: boolean;
  hidden: boolean;
  landed: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onAutoFix?: () => void;
  onRerun?: () => void;
  onAssign?: (userId: string | null) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  return (
    // FLIP (see `use-flip-lanes`) owns this wrapper's `transform`/`transition`
    // imperatively, outside React — it needs an element React never re-styles
    // itself, since dnd-kit's own transform/transition below is applied to the
    // card and gets reset on every render, which would cancel FLIP's animation
    // as soon as any unrelated re-render landed mid-flight.
    <div className="flex" data-flip-id={item.id} data-flip-lane={item.status}>
      <TaskCard
        {...props}
        item={item}
        dragRef={setNodeRef}
        bindings={{ attributes, listeners }}
        className={cn("w-full", landed && "animate-card-land")}
        style={{
          transform: CSS.Translate.toString(transform),
          transition,
          // The dragged card (and the rest of its group, riding along in the
          // overlay) leaves a gap rather than a ghost.
          opacity: isDragging || hidden ? 0 : undefined,
        }}
      />
    </div>
  );
}

function TaskCard({
  item,
  assignee,
  assignedBy,
  members,
  selected,
  className,
  dragRef,
  bindings,
  style,
  onToggleSelect,
  onOpen,
  onAutoFix,
  onRerun,
  onAssign,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  selected?: boolean;
  className?: string;
  /** Supplied by `SortableTaskCard`; absent for the DragOverlay clone. */
  dragRef?: (node: HTMLElement | null) => void;
  bindings?: SortableBindings;
  style?: CSSProperties;
  onToggleSelect?: () => void;
  onOpen: () => void;
  onAutoFix?: () => void;
  onRerun?: () => void;
  onAssign?: (userId: string | null) => void;
}) {
  const t = useT();
  const StatusIcon = STATUS_CONFIG[item.status].icon;
  // The Super Agent's own thread, not one of its reviewers' — falls back to
  // the most recent thread overall so a card still shows something before the
  // reviewer/main distinction exists (e.g. mid-migration data).
  const mainThread =
    item.threads.find(
      (thr) =>
        !isReviewerThreadTitle(thr.title, "qa") &&
        !isReviewerThreadTitle(thr.title, "code_review"),
    ) ?? primaryThread(item);
  const reviewThreads = reviewerThreads(item);

  const showAutoFix =
    onAutoFix &&
    (item.status === "triage" || item.status === "todo") &&
    item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID;

  // The counterpart for a card the Super Agent already owns. Auto-fix hides
  // itself once assigned (it delegates, and it's already delegated), which left
  // such a card with NO way to start a run — and re-picking the same assignee
  // is a no-op, so a stalled card was unrecoverable from the board.
  //
  // Deliberately NOT gated on "no run in flight": the cards that need this most
  // are the ones whose thread reads `in_progress` forever because its run never
  // started, and hiding the button behind a liveness check is exactly what made
  // them unrecoverable. The confirm dialog carries the warning instead.
  const showRerun =
    onRerun &&
    !showAutoFix &&
    item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
    item.status !== "done";

  return (
    <button
      type="button"
      ref={dragRef}
      style={style}
      {...bindings?.attributes}
      {...bindings?.listeners}
      onClick={(e) => {
        if (e.shiftKey && onToggleSelect) onToggleSelect();
        else onOpen();
      }}
      className={cn(
        "group relative flex shrink-0 cursor-grab flex-col gap-2 rounded-xl bg-card px-3 py-2.5 text-left card-shadow hover:bg-accent/60 active:cursor-grabbing",
        selected && "bg-accent",
        className,
      )}
      title={item.title}
    >
      <div className="flex items-start gap-2">
        <StatusIcon
          size={16}
          className={cn("mt-px shrink-0", statusIconClassName(item))}
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

      {(isTaskBlocked(item) ||
        item.priority !== "none" ||
        Boolean(item.dueDate) ||
        item.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 pl-6">
          {isTaskBlocked(item) && <BlockedBadge />}
          {item.priority !== "none" && (
            <PriorityPill priority={item.priority} />
          )}
          {item.dueDate && <DueDatePill iso={item.dueDate} />}
          {item.tags.map((tag) => (
            <TagPill key={tag.id} tag={tag} />
          ))}
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

      {showRerun && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRerun();
          }}
          // Absolutely positioned so it never reserves layout space: every
          // Super-Agent card qualifies, so a flow-positioned hover button
          // left a permanent empty gap on every card, and showing it
          // unconditionally would put a button on nearly the whole board.
          className="pointer-events-none absolute bottom-2 right-2 z-10 flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground opacity-0 shadow-sm transition-opacity hover:bg-accent focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
        >
          <RefreshCw01 size={12} />
          {t("taskBoard.taskBoard.rerun")}
        </button>
      )}

      {mainThread && (
        <AgentReviewFooter
          mainThread={mainThread}
          reviewThreads={reviewThreads}
        />
      )}
    </button>
  );
}

/** An agent thread paired with its glyph kind and display name, for the card footer. */
type FooterAgent = {
  kind: "main" | ReviewerKind;
  name: string;
  thread: TaskBoardItemThread;
};

/** Rank for picking which agent's row the card footer shows — lower wins. A
 *  running/awaiting-input agent is always the most important thing on the
 *  card; once nothing is running, a failure is the most important thing;
 *  otherwise (everything `completed`) the most recently run agent wins. */
function statusPriority(status: TaskBoardItemThread["status"]): number {
  if (status === "in_progress" || status === "requires_action") return 0;
  if (status === "failed") return 1;
  return 2;
}

/**
 * The card footer shows a single row for whichever agent thread — the Super
 * Agent's own run, or a QA/code-review thread — matters most right now:
 * something running or awaiting input beats everything else, an error beats
 * a clean run, and among equals the most recently run agent wins. Stacking
 * all three threads (one row each, or a row plus a collapsed icon strip)
 * cost more space than it was worth for a card whose job is a quick glance —
 * full activity detail already lives one click away in the task dialog.
 */
function AgentReviewFooter({
  mainThread,
  reviewThreads,
}: {
  mainThread: TaskBoardItemThread;
  reviewThreads: { kind: ReviewerKind; thread: TaskBoardItemThread }[];
}) {
  const t = useT();
  const agents: FooterAgent[] = [
    {
      kind: "main",
      name: t("taskBoard.taskDialog.superAgentDefaultName"),
      thread: mainThread,
    },
    ...reviewThreads.map(({ kind, thread }) => ({
      kind,
      name: t(
        kind === "qa"
          ? "taskBoard.taskDialog.qaAgentLabel"
          : "taskBoard.taskDialog.codeReviewerLabel",
      ),
      thread,
    })),
  ];
  const featuredAgent = agents.reduce((best, agent) => {
    const rank = statusPriority(agent.thread.status);
    const bestRank = statusPriority(best.thread.status);
    if (rank !== bestRank) return rank < bestRank ? agent : best;
    return agent.thread.createdAt > best.thread.createdAt ? agent : best;
  });

  return (
    <div className="-mx-3 flex flex-col gap-1.5 border-t border-border px-3 pt-3">
      <AgentThreadFooterRow {...featuredAgent} />
    </div>
  );
}

/** An agent's glyph — the Super Agent capybara, or the QA/Code Reviewer badge. */
function AgentGlyph({
  kind,
  size,
  className,
}: {
  kind: FooterAgent["kind"];
  size: number;
  className?: string;
}) {
  if (kind === "qa") return <QaAgentIcon size={size} className={className} />;
  if (kind === "code_review") {
    return <CodeReviewerIcon size={size} className={className} />;
  }
  return <SuperAgentIcon size={size} className={className} />;
}

/**
 * One agent's row in the card footer, all on a single truncated line: glyph,
 * name, its live status — e.g. the red "Error" state — then a preview of the
 * thread's last message. A condensed version of `ThreadActivityItem`'s status
 * row in the task dialog.
 */
function AgentThreadFooterRow({ kind, name, thread }: FooterAgent) {
  const t = useT();
  const state = thread.status ? threadStatusStyle(thread.status, t) : null;

  return (
    <div className="flex items-center gap-1.5">
      <AgentGlyph kind={kind} size={16} />
      <span className="shrink-0 text-xs font-medium text-foreground">
        {name}
      </span>
      {state && (
        <span
          className={cn("flex shrink-0 items-center gap-1", state.className)}
        >
          <state.icon size={12} className={cn(state.spin && "animate-spin")} />
          <span className="text-xs">{state.label}</span>
        </span>
      )}
      {thread.lastMessage && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {thread.lastMessage}
        </span>
      )}
    </div>
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
  const StatusIcon = STATUS_CONFIG[item.status].icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-left card-shadow transition-colors hover:bg-accent/60"
    >
      <StatusIcon
        size={16}
        className={cn("shrink-0", statusIconClassName(item))}
      />
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
      {item.tags.length > 0 && (
        <span className="hidden items-center gap-1.5 sm:inline-flex">
          {item.tags.slice(0, 2).map((tag) => (
            <TagPill key={tag.id} tag={tag} />
          ))}
          {item.tags.length > 2 && (
            <span className={PILL}>+{item.tags.length - 2}</span>
          )}
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
