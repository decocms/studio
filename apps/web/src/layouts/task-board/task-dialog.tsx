import { Fragment, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { Calendar as DayPickerCalendar } from "@decocms/ui/components/calendar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import {
  AlertCircle,
  AlertSquare,
  Calendar,
  Check,
  CheckCircle,
  ChevronRight,
  Coins01,
  Copy01,
  DotsHorizontal,
  Edit05,
  GitMerge,
  GitPullRequest,
  Globe01,
  HelpCircle,
  LinkExternal01,
  Lightning01,
  Loading02,
  Lock01,
  Plus,
  RefreshCw01,
  Tag01,
  Trash03,
  UserPlus01,
  X,
} from "@untitledui/icons";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { QaAgentIcon } from "@/components/qa-agent-icon";
import { CodeReviewerIcon } from "@/components/code-reviewer-icon";
import { MemoizedMarkdown } from "@/components/chat/markdown";
import {
  isReportsTask,
  isReviewerThreadTitle,
} from "@decocms/shared/task-board";
import { MarkdownEditor } from "@/components/markdown-editor";
import { useMembers } from "@/hooks/use-members";
import { useCreateTag, useDeleteTag, useTags } from "@/hooks/use-tags";
import { getInitials } from "@/lib/get-initials";
import { useT } from "@/i18n/use-t.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  nextTagColor,
  PRIORITIES,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  statusIconClassName,
  SUPER_AGENT_ASSIGNEE_ID,
  tagDotColor,
  type Member,
  type TaskBoardItem,
  type TaskBoardItemPr,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type TaskBoardItemThread,
} from "./config";
import { toast } from "sonner";
import { useTaskBoardItemPrs } from "@/hooks/use-task-board-item-prs";
import {
  useTaskBoardActivity,
  type TaskBoardActivity,
} from "@/hooks/use-task-board-activity";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { usePromoteToProduction } from "@/hooks/use-promote-to-production";
import {
  enabledReviewers,
  reviewsSatisfiedForPromotion,
} from "./review-status";
import { formatTimeAgo } from "@/lib/format-time";
import { GitHubIcon } from "@/components/icons/github-icon";
import { useConnections } from "@/sdk";
import { listRepoScopeLabels } from "@decocms/shared/github-repo-scope";
import { AssigneePickerContent } from "./assignee-picker";
import { TagPickerContent } from "./tag-picker";
import { extractDescriptionLinks } from "./description-links";
import { authClient } from "@/lib/auth-client";
import {
  CommentThreadCard,
  NewCommentComposer,
  type CommentAuthor,
  type TaskComment,
} from "./task-comments";
import { useTaskBoardComments } from "@/hooks/use-task-board-comments";

// ponytail: pinned to end-of-day so "due today" doesn't flip to overdue
// mid-morning. Local zone in, UTC out.
export function toEndOfDayIso(d: Date): string {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
  ).toISOString();
}

function parseIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DUE_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/**
 * Property control that opens an editor popover/menu. Outlined chip on mobile
 * (wrapping row); a borderless ghost row in the desktop sidebar.
 */
const PROPERTY_BUTTON =
  "inline-flex h-9 items-center justify-start gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:border-transparent";

/**
 * What this task has cost, summed over every run linked to it.
 *
 * The task, not the run, is the unit that matters: a card is a Super Agent run
 * plus however many reviewer and re-run rounds it took, and until now that
 * total existed nowhere a person could see — one production card reached 105
 * runs before anyone noticed. Read-only on purpose; it is a fact about the
 * card, not a setting.
 *
 * Hidden entirely when no run recorded usage, so a card that never ran shows
 * nothing rather than a $0.00 we did not measure.
 */
function TaskCost({ threads }: { threads?: TaskBoardItemThread[] }) {
  const t = useT();
  const priced = (threads ?? []).filter((thread) => thread.costUsd !== null);
  if (priced.length === 0) return null;
  const total = priced.reduce((sum, thread) => sum + (thread.costUsd ?? 0), 0);
  return (
    <div
      className={cn(PROPERTY_BUTTON, "cursor-default hover:bg-transparent")}
      title={t("taskBoard.taskDialog.costTooltip", {
        runs: String((threads ?? []).length),
      })}
    >
      <Coins01 size={16} className="shrink-0 text-muted-foreground" />
      <span className="tabular-nums">
        {total.toLocaleString(undefined, {
          style: "currency",
          currency: "USD",
        })}
      </span>
      <span className="text-muted-foreground">
        {t("taskBoard.taskDialog.costRunCount", {
          runs: String((threads ?? []).length),
        })}
      </span>
    </div>
  );
}

export function TaskBoardItemDialog({
  open,
  onClose,
  item,
  defaultStatus,
  onSubmit,
  onDelete,
  onOpenThread,
  onNewChat,
  onAutoFix,
  onRerun,
  isSaving,
}: {
  open: boolean;
  onClose: () => void;
  /** Present in edit mode, prefills the form. */
  item?: TaskBoardItem;
  /** In create mode, the status to start the new task in (e.g. the lane the
   * "+" was clicked from). Falls back to "triage". */
  defaultStatus?: TaskBoardItemStatus;
  onSubmit: (input: {
    title: string;
    description: string | null;
    status: TaskBoardItemStatus;
    priority: TaskBoardItemPriority;
    assigneeId: string | null;
    repo: string | null;
    dueDate: string | null;
    tagIds: string[];
  }) => void;
  onDelete?: () => void;
  onOpenThread?: (thread: TaskBoardItemThread) => void;
  /** Edit mode only: start a fresh chat seeded with this task as context. */
  onNewChat?: () => void;
  /** Edit mode only: hand the task to the Super Agent. */
  onAutoFix?: () => void;
  onRerun?: () => void;
  isSaving?: boolean;
}) {
  const t = useT();
  const { data } = useMembers();
  const members = (data?.data?.members ?? []) as Member[];
  const { handleCopy, copied } = useCopy();
  const { data: orgTags = [] } = useTags();
  const createTag = useCreateTag();
  const deleteTag = useDeleteTag();

  // The org's repos (which site a task pertains to).
  const repos = listRepoScopeLabels(useConnections({ slug: "mcp-github" }));

  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [status, setStatus] = useState<TaskBoardItemStatus>(
    item?.status ?? defaultStatus ?? "triage",
  );
  const [priority, setPriority] = useState<TaskBoardItemPriority>(
    item?.priority ?? "medium",
  );
  const [assigneeId, setAssigneeId] = useState<string | null>(
    item?.assigneeId ?? null,
  );
  const [repo, setRepo] = useState<string | null>(item?.repo ?? null);
  const [dueDate, setDueDate] = useState<Date | null>(
    parseIsoDate(item?.dueDate),
  );
  const [tagIds, setTagIds] = useState<string[]>(
    item?.tags.map((tag) => tag.id) ?? [],
  );
  const [dueOpen, setDueOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);

  const reset = () => {
    setTitle(item?.title ?? "");
    setDescription(item?.description ?? "");
    setStatus(item?.status ?? defaultStatus ?? "triage");
    setPriority(item?.priority ?? "medium");
    setAssigneeId(item?.assigneeId ?? null);
    setRepo(item?.repo ?? null);
    setDueDate(parseIsoDate(item?.dueDate));
    setTagIds(item?.tags.map((tag) => tag.id) ?? []);
  };

  const close = () => {
    onClose();
    reset();
  };

  const createAndSelectTag = async (name: string, color: string) => {
    const tag = await createTag.mutateAsync({ name, color });
    setTagIds((prev) => [...prev, tag.id]);
  };

  const deleteOrgTag = (tagId: string) => {
    deleteTag.mutate(tagId);
    setTagIds((prev) => prev.filter((id) => id !== tagId));
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSubmit({
      title: trimmed,
      description: description.trim() || null,
      status,
      priority,
      assigneeId,
      repo,
      dueDate: dueDate ? toEndOfDayIso(dueDate) : null,
      tagIds,
    });
  };

  const isSuperAgent = assigneeId === SUPER_AGENT_ASSIGNEE_ID;
  const showAutoFix =
    item &&
    onAutoFix &&
    (status === "triage" || status === "todo") &&
    !isSuperAgent;

  // Auto-fix's counterpart once the Super Agent owns the task: re-queue a run.
  // Without this the dialog had no way to start one either — the assignee picker
  // still opens, but re-picking Super Agent leaves the form clean, so Save never
  // appears and the pick is discarded. Read against the SAVED assignee, not the
  // form's: this re-runs the task as it exists, and offering it next to unsaved
  // edits would imply the edits are part of the run.
  const showRerun =
    item && onRerun && item.assigneeId === SUPER_AGENT_ASSIGNEE_ID;

  // Save is create-mode-always, but in edit mode only surfaces once the form
  // actually diverges from the task as loaded — otherwise it's a no-op button
  // sitting next to New chat / Auto-fix for no reason.
  const initialTagIds = item?.tags.map((tag) => tag.id) ?? [];
  const isDirty =
    !item ||
    title.trim() !== item.title ||
    (description.trim() || null) !== item.description ||
    status !== item.status ||
    priority !== item.priority ||
    assigneeId !== (item.assigneeId ?? null) ||
    repo !== (item.repo ?? null) ||
    (dueDate ? toEndOfDayIso(dueDate) : null) !== (item.dueDate ?? null) ||
    tagIds.length !== initialTagIds.length ||
    !tagIds.every((id) => initialTagIds.includes(id));
  const assignee = members.find((m) => m.userId === assigneeId);
  const assignedBy = item?.assignedBy
    ? members.find((m) => m.userId === item.assignedBy)
    : undefined;
  const StatusIcon = STATUS_CONFIG[status].icon;
  // Reports-generated tasks: content (title/description/priority) is owned by
  // the reports sync, which refreshes it on open items — TASK_BOARD_ITEM_UPDATE
  // rejects a write that touches any of those fields. Board interactions
  // (status/drag, assignee/delegating, due date, tags) stay free.
  const contentLocked = !!item && isReportsTask(item);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="flex max-h-[92vh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[90vh] sm:max-h-[820px] sm:max-w-[1040px]"
        closeButtonClassName="hidden"
      >
        <DialogTitle className="sr-only">
          {item
            ? t("taskBoard.taskDialog.editTaskTitle")
            : t("taskBoard.taskDialog.newTaskTitle")}
        </DialogTitle>

        <button
          type="button"
          aria-label={t("taskBoard.taskDialog.closeAriaLabel")}
          onClick={close}
          className="absolute right-2.5 top-2.5 z-10 flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row sm:overflow-hidden">
          {/* Editor pane — content-height on mobile so it doesn't leave a big
              gap above the properties; fills the column on desktop. */}
          <div className="flex min-w-0 flex-col sm:flex-1 sm:overflow-y-auto">
            {/* Sticky so a long description never scrolls the title out of
                view — the title is the one thing that should stay put. z-20
                keeps it above the activity timeline's avatars (z-10), which
                would otherwise paint over it once scrolled underneath. */}
            <div className="sticky top-0 z-20 bg-background p-6 pb-0 sm:p-8 sm:pb-0">
              <textarea
                ref={(el) => {
                  if (!el) return;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                value={title}
                onChange={(e) => {
                  if (contentLocked) return;
                  setTitle(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
                placeholder={t("taskBoard.taskDialog.taskTitlePlaceholder")}
                autoFocus
                rows={1}
                readOnly={contentLocked}
                className={cn(
                  "w-full resize-none overflow-hidden border-0 bg-transparent text-xl font-medium leading-snug text-foreground outline-none placeholder:text-foreground/30",
                  contentLocked && "cursor-default",
                )}
              />
              {contentLocked && (
                <p className="mb-3 mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock01 size={12} />
                  {t("taskBoard.taskDialog.reportsContentLocked")}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-6 p-6 pt-6 sm:p-8 sm:pt-6">
              <div className="group relative flex flex-col">
                {/* Markdown in, markdown out — the value also becomes prompt
                    context for the agent, and plain-text descriptions written
                    before this editor existed still parse as-is. Grows with its
                    content so the pane scrolls, not an inner scrollbar. */}
                <MarkdownEditor
                  defaultValue={description}
                  onChange={setDescription}
                  placeholder={t("taskBoard.taskDialog.descriptionPlaceholder")}
                  editable={!contentLocked}
                />
                {description && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t(
                      "taskBoard.taskDialog.copyDescriptionAriaLabel",
                    )}
                    className="absolute right-0 top-0 size-7 rounded-md border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => handleCopy(description)}
                  >
                    {copied ? <Check size={14} /> : <Copy01 size={14} />}
                  </Button>
                )}
              </div>

              {/* Separates the task itself from the record of it (links,
                  activity). Edit mode only — a new task has neither. */}
              {item && <hr className="border-border" />}

              {item?.id && (
                <LinksSection
                  item={item}
                  description={description}
                  onOpenThread={onOpenThread}
                />
              )}

              {item && (
                <ActivitySection
                  item={item}
                  members={members}
                  startedBy={assignedBy ?? assignee}
                  onOpenThread={onOpenThread}
                />
              )}
            </div>
          </div>

          {/* Properties pane — wrapping chips under the editor on mobile, a
              stacked sidebar on desktop. */}
          <div className="flex w-full shrink-0 flex-col gap-4 border-t border-border p-6 sm:w-[220px] sm:border-t-0 sm:border-l sm:px-6 sm:py-10">
            <span className="hidden px-3 text-sm text-muted-foreground sm:block">
              {t("taskBoard.taskDialog.propertiesLabel")}
            </span>

            <div className="flex flex-wrap gap-2 sm:flex-col">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={PROPERTY_BUTTON}>
                    <StatusIcon
                      size={16}
                      className={cn(
                        item
                          ? statusIconClassName({ ...item, status })
                          : STATUS_CONFIG[status].iconClassName,
                      )}
                    />
                    {t(STATUS_CONFIG[status].labelKey)}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  {STATUSES.map((s) => {
                    const Icon = STATUS_CONFIG[s].icon;
                    return (
                      <DropdownMenuItem
                        key={s}
                        onSelect={() => setStatus(s)}
                        className="gap-2"
                      >
                        <Icon
                          size={16}
                          className={STATUS_CONFIG[s].iconClassName}
                        />
                        {t(STATUS_CONFIG[s].labelKey)}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={contentLocked}
                    title={
                      contentLocked
                        ? t("taskBoard.taskDialog.reportsContentLocked")
                        : undefined
                    }
                    className={cn(
                      PROPERTY_BUTTON,
                      priority === "none" && "text-muted-foreground",
                      contentLocked && "cursor-default opacity-60",
                    )}
                  >
                    {priority === "none" ? (
                      <>
                        <DotsHorizontal size={16} />
                        {t("taskBoard.taskDialog.setPriorityButton")}
                      </>
                    ) : (
                      <>
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            PRIORITY_CONFIG[priority].dotClassName,
                          )}
                        />
                        {t(PRIORITY_CONFIG[priority].labelKey)}
                      </>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  {PRIORITIES.map((p) => (
                    <DropdownMenuItem key={p} onSelect={() => setPriority(p)}>
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          PRIORITY_CONFIG[p].dotClassName,
                        )}
                      />
                      {t(PRIORITY_CONFIG[p].labelKey)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Which repo (site) this task pertains to — scopes it to a
                  site's task pill in the task-based flow. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      PROPERTY_BUTTON,
                      "w-full min-w-0",
                      !repo && "text-muted-foreground",
                    )}
                  >
                    <GitHubIcon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {repo ?? t("taskBoard.taskDialog.repoButton")}
                    </span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem onSelect={() => setRepo(null)}>
                    {t("taskBoard.taskDialog.noRepo")}
                  </DropdownMenuItem>
                  {repos.map((r) => (
                    <DropdownMenuItem
                      key={r}
                      className="gap-2"
                      onSelect={() => setRepo(r)}
                    >
                      <GitHubIcon className="size-4 shrink-0" />
                      <span className="truncate">{r}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <TaskCost threads={item?.threads} />

              <div className="flex flex-col">
                {/* modal: without it the parent Dialog's scroll-lock
                    (react-remove-scroll) swallows wheel events over this
                    portalled popover, so the member list only scrolls via
                    keyboard/click. modal wraps the content in its own
                    RemoveScroll that whitelists the popover. */}
                <Popover
                  open={assigneeOpen}
                  onOpenChange={setAssigneeOpen}
                  modal
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        PROPERTY_BUTTON,
                        !assigneeId && "text-muted-foreground",
                      )}
                    >
                      {isSuperAgent && assignedBy ? (
                        <>
                          {/* Desktop: the assigner; the Super Agent doing the
                              work is the nested elbow row below. */}
                          <span className="hidden items-center gap-2 sm:flex">
                            <Avatar
                              url={assignedBy.user?.image ?? undefined}
                              fallback={getInitials(assignedBy.user?.name)}
                              shape="circle"
                              size="2xs"
                            />
                            <span className="truncate">
                              {assignedBy.user?.name ??
                                t("taskBoard.taskDialog.superAgentDefaultName")}
                            </span>
                          </span>
                          {/* Mobile: no room for the elbow tree — fold the
                              delegation into one chip, the assigner eclipsed by
                              the Super Agent. */}
                          <span className="flex items-center gap-2 sm:hidden">
                            <span className="inline-flex items-center">
                              <Avatar
                                url={assignedBy.user?.image ?? undefined}
                                fallback={getInitials(assignedBy.user?.name)}
                                shape="circle"
                                size="2xs"
                                className="-mr-1.5 ring-2 ring-background"
                              />
                              <SuperAgentIcon
                                size={16}
                                className="ring-2 ring-background"
                              />
                            </span>
                            {t("taskBoard.taskDialog.superAgentLabel")}
                          </span>
                        </>
                      ) : isSuperAgent ? (
                        <>
                          <SuperAgentIcon size={16} />
                          {t("taskBoard.taskDialog.superAgentLabel")}
                        </>
                      ) : assignee ? (
                        <>
                          <Avatar
                            url={assignee.user?.image ?? undefined}
                            fallback={getInitials(assignee.user?.name)}
                            shape="circle"
                            size="2xs"
                          />
                          <span className="truncate">
                            {assignee.user?.name ??
                              t("taskBoard.taskDialog.unassignedLabel")}
                          </span>
                        </>
                      ) : (
                        <>
                          <UserPlus01
                            size={16}
                            className="text-muted-foreground"
                          />
                          {t("taskBoard.taskDialog.assignButton")}
                        </>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-56 p-0">
                    <AssigneePickerContent
                      members={members}
                      onSelect={(userId) => {
                        setAssigneeOpen(false);
                        // Re-picking the Super Agent on a card it already owns
                        // leaves the form clean, so Save never appears and the
                        // pick is silently discarded — which is what "I
                        // assigned it to Auto fix and it stayed in To Do"
                        // actually was. That intent is a re-run; hand it to the
                        // same confirm the Rerun button uses.
                        if (
                          userId === SUPER_AGENT_ASSIGNEE_ID &&
                          item?.assigneeId === SUPER_AGENT_ASSIGNEE_ID
                        ) {
                          onRerun?.();
                          return;
                        }
                        setAssigneeId(userId);
                      }}
                    />
                  </PopoverContent>
                </Popover>

                {/* Delegation: the Super Agent doing the work, nested under
                    the human who handed it off. Desktop only — on mobile the
                    assignee chip folds this in (see above). */}
                {isSuperAgent && assignedBy && (
                  <div className="relative mt-1.5 hidden items-center pl-5 sm:flex">
                    {/* Elbow drops from the center of the assigner's avatar
                        (px-3 padding + half of the w-4 "2xs" avatar = 20px).
                        Starts 6px above the row to bridge the mt-1.5 gap and
                        still land at this row's vertical center. */}
                    <span className="absolute -top-1.5 left-5 h-[calc(50%+0.375rem)] w-2.5 rounded-bl-md border-b border-l border-border" />
                    <span
                      className={cn(PROPERTY_BUTTON, "pointer-events-none")}
                    >
                      <SuperAgentIcon size={16} />
                      {t("taskBoard.taskDialog.superAgentLabel")}
                    </span>
                  </div>
                )}
              </div>

              <Popover open={dueOpen} onOpenChange={setDueOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      PROPERTY_BUTTON,
                      !dueDate && "text-muted-foreground",
                    )}
                  >
                    <Calendar size={16} className="text-muted-foreground" />
                    {dueDate
                      ? DUE_DATE_FMT.format(dueDate)
                      : t("taskBoard.taskDialog.dueDateLabel")}
                    {dueDate && (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t(
                          "taskBoard.taskDialog.clearDueDateAriaLabel",
                        )}
                        className="-mr-1 ml-0.5 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDueDate(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            setDueDate(null);
                          }
                        }}
                      >
                        <X size={12} />
                      </span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <DayPickerCalendar
                    mode="single"
                    selected={dueDate ?? undefined}
                    onSelect={(next) => {
                      setDueDate(next ?? null);
                      if (next) setDueOpen(false);
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>

              <Popover open={tagsOpen} onOpenChange={setTagsOpen} modal>
                {tagIds.length === 0 ? (
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(PROPERTY_BUTTON, "text-muted-foreground")}
                    >
                      <Tag01 size={16} />
                      {t("taskBoard.taskDialog.tagsButton")}
                    </button>
                  </PopoverTrigger>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5 sm:px-3">
                    {tagIds.map((tagId) => {
                      const tag = orgTags.find((ot) => ot.id === tagId);
                      if (!tag) return null;
                      return (
                        <button
                          key={tagId}
                          type="button"
                          onClick={() => setTagsOpen(true)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                        >
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: tagDotColor(tag.color) }}
                          />
                          <span className="truncate">{tag.name}</span>
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={t(
                              "taskBoard.taskDialog.removeTagAriaLabel",
                              { name: tag.name },
                            )}
                            className="-mr-0.5 flex size-3.5 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTagIds((prev) =>
                                prev.filter((id) => id !== tagId),
                              );
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                setTagIds((prev) =>
                                  prev.filter((id) => id !== tagId),
                                );
                              }
                            }}
                          >
                            <X size={10} />
                          </span>
                        </button>
                      );
                    })}
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label={t("taskBoard.taskDialog.addTagButton")}
                        className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Plus size={14} />
                      </button>
                    </PopoverTrigger>
                  </div>
                )}
                <PopoverContent align="start" className="w-56 p-0">
                  <TagPickerContent
                    tags={orgTags}
                    selectedIds={tagIds}
                    defaultColor={nextTagColor(orgTags.length)}
                    onToggle={(tagId) =>
                      setTagIds((prev) =>
                        prev.includes(tagId)
                          ? prev.filter((id) => id !== tagId)
                          : [...prev, tagId],
                      )
                    }
                    onCreate={createAndSelectTag}
                    onDelete={deleteOrgTag}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>

        <div className="flex h-16 items-center justify-between border-t border-border px-4">
          {item && onDelete ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("taskBoard.taskDialog.deleteTaskAriaLabel")}
              className="size-10 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash03 size={16} />
            </Button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            {item && onNewChat && (
              <Button variant="outline" size="sm" onClick={onNewChat}>
                <Edit05 size={16} />
                {t("taskBoard.taskDialog.newChatButton")}
              </Button>
            )}
            {showAutoFix && (
              <Button size="sm" onClick={onAutoFix}>
                <Lightning01 size={16} />
                {t("taskBoard.taskBoard.autoFix")}
              </Button>
            )}
            {showRerun && (
              <Button variant="outline" size="sm" onClick={onRerun}>
                <RefreshCw01 size={16} />
                {t("taskBoard.taskBoard.rerun")}
              </Button>
            )}
            {isDirty && (
              <Button
                size="sm"
                disabled={!title.trim() || isSaving}
                onClick={submit}
              >
                {/* The + belongs to creating a task; saving an existing one
                    isn't adding anything. */}
                {item ? null : <Plus size={16} />}
                {item
                  ? t("taskBoard.taskDialog.saveButton")
                  : t("taskBoard.taskDialog.createTaskButton")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Live-status style for a linked thread (agent session). */
export function threadStatusStyle(
  status: NonNullable<TaskBoardItemThread["status"]>,
  t: ReturnType<typeof useT>,
): {
  label: string;
  className: string;
  icon: typeof AlertSquare;
  spin?: boolean;
} {
  switch (status) {
    case "failed":
      return {
        label: t("taskBoard.taskDialog.threadStatusError"),
        className: "text-destructive",
        icon: AlertSquare,
      };
    case "requires_action":
      return {
        label: t("taskBoard.taskDialog.threadStatusNeedsInput"),
        className: "text-warning",
        icon: HelpCircle,
      };
    case "in_progress":
      return {
        label: t("taskBoard.taskDialog.threadStatusRunning"),
        className: "text-primary",
        icon: Loading02,
        spin: true,
      };
    case "completed":
      return {
        label: t("taskBoard.taskDialog.threadStatusCompleted"),
        className: "text-success",
        icon: CheckCircle,
      };
    case "expired":
      return {
        label: t("taskBoard.taskDialog.threadStatusExpired"),
        className: "text-muted-foreground",
        icon: AlertCircle,
      };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * A linked agent session (thread) — the WHOLE card is clickable (opens the
 * run's chat), with a hover state + "Open" affordance so it's obvious it's
 * interactive, plus the live run status and last message.
 */
function ThreadActivityItem({
  thread,
  startedBy,
  onOpen,
}: {
  thread: TaskBoardItemThread;
  startedBy?: Member;
  onOpen?: (thread: TaskBoardItemThread) => void;
}) {
  const t = useT();
  const state = thread.status ? threadStatusStyle(thread.status, t) : null;
  const message = thread.lastMessage;
  // The Super Agent and both reviewers run on the org agent, distinguished only
  // by their thread title prefix — reflect that in the card's glyph/name.
  const isQaThread = isReviewerThreadTitle(thread.title, "qa");
  const isCodeReviewThread = isReviewerThreadTitle(thread.title, "code_review");

  return (
    <button
      type="button"
      disabled={!onOpen}
      onClick={() => onOpen?.(thread)}
      className="group flex w-full flex-col gap-2 rounded-xl bg-card p-4 text-left card-shadow transition-colors enabled:hover:bg-muted/60 disabled:cursor-default"
    >
      <div className="flex items-center gap-2">
        {isQaThread ? (
          <QaAgentIcon size={16} className="shrink-0" />
        ) : isCodeReviewThread ? (
          <CodeReviewerIcon size={16} className="shrink-0" />
        ) : (
          <SuperAgentIcon size={16} className="shrink-0" />
        )}
        <span className="truncate text-sm font-medium text-foreground">
          {thread.title || t("taskBoard.taskDialog.superAgentDefaultName")}
        </span>
        {startedBy && (
          <>
            <span className="shrink-0 text-sm text-muted-foreground/50">
              {t("taskBoard.taskDialog.startedByLabel")}
            </span>
            <Avatar
              url={startedBy.user?.image ?? undefined}
              fallback={getInitials(startedBy.user?.name)}
              shape="circle"
              size="2xs"
            />
            <span className="truncate text-sm text-foreground">
              {startedBy.user?.name ?? t("taskBoard.taskDialog.someoneLabel")}
            </span>
          </>
        )}
        {onOpen && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground/60 group-hover:text-foreground">
            {t("taskBoard.taskDialog.openThreadHint")}
            <ChevronRight size={14} />
          </span>
        )}
      </div>
      {state && (
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5",
              state.className,
            )}
          >
            <state.icon
              size={15}
              className={cn(state.spin && "animate-spin")}
            />
            <span className="text-sm">{state.label}</span>
          </span>
          {message && (
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {message}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

/** Icon + label + color for a PR's live state (merged/closed/draft/open). */
function prStateStyle(
  pr: TaskBoardItemPr,
  t: ReturnType<typeof useT>,
): {
  label: string;
  className: string;
  icon: typeof GitPullRequest;
} {
  if (pr.merged)
    return {
      label: t("taskBoard.taskDialog.prStateMerged"),
      className: "text-special",
      icon: GitMerge,
    };
  if (pr.state === "closed")
    return {
      label: t("taskBoard.taskDialog.prStateClosed"),
      className: "text-destructive",
      icon: GitPullRequest,
    };
  if (pr.draft)
    return {
      label: t("taskBoard.taskDialog.prStateDraft"),
      className: "text-muted-foreground",
      icon: GitPullRequest,
    };
  // "open" or unknown live state — still a link the user can follow.
  return {
    label: t("taskBoard.taskDialog.prStateOpen"),
    className: "text-success",
    icon: GitPullRequest,
  };
}

/** Icon + label + color for a PR's live CI checks state. `null` renders
 *  nothing — a PR with no checks shouldn't show a badge at all. */
function prChecksStyle(
  checksStatus: TaskBoardItemPr["checksStatus"],
  t: ReturnType<typeof useT>,
): { label: string; className: string; icon: typeof CheckCircle } | null {
  switch (checksStatus) {
    case "passing":
      return {
        label: t("taskBoard.taskDialog.prChecksPassing"),
        className: "text-success",
        icon: CheckCircle,
      };
    case "failing":
      return {
        label: t("taskBoard.taskDialog.prChecksFailing"),
        className: "text-destructive",
        icon: AlertCircle,
      };
    case "pending":
      return {
        label: t("taskBoard.taskDialog.prChecksPending"),
        className: "text-warning",
        icon: Loading02,
      };
    default:
      return null;
  }
}

/** Check-run conclusions that mean the run failed. */
const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

/** Icon + color for one CI check row in the footer. */
function checkRunStyle(check: TaskBoardItemPr["checks"][number]): {
  icon: typeof CheckCircle;
  className: string;
  spin: boolean;
} {
  if (check.status !== "completed") {
    return { icon: Loading02, className: "text-warning", spin: true };
  }
  const c = check.conclusion;
  if (c && FAILED_CHECK_CONCLUSIONS.has(c)) {
    return { icon: AlertCircle, className: "text-destructive", spin: false };
  }
  if (c === "success" || c === "neutral" || c === "skipped") {
    return { icon: CheckCircle, className: "text-success", spin: false };
  }
  return { icon: HelpCircle, className: "text-muted-foreground", spin: false };
}

/**
 * One PR card: identity + the `#123 ↗` GitHub link, an action row (Edit /
 * preview / ship), and an expandable checks footer that opens each CI check
 * with its GitHub output markdown (fetched for failing runs).
 */
function PrCard({
  pr,
  previewThread,
  reviewsReady,
  shipPending,
  onShip,
  onOpenThread,
}: {
  pr: TaskBoardItemPr;
  previewThread?: TaskBoardItemThread;
  /** Task-level: In Review + every enabled reviewer approved. */
  reviewsReady: boolean;
  shipPending: boolean;
  onShip: () => void;
  onOpenThread?: (thread: TaskBoardItemThread) => void;
}) {
  const t = useT();
  const [checksOpen, setChecksOpen] = useState(false);
  const style = prStateStyle(pr, t);
  const checksHeader = prChecksStyle(pr.checksStatus, t);
  const isOpen = pr.state === "open" && !pr.merged;
  // Hide Ship only on red CI; a human may ship over in-flight (pending) checks.
  const checksOk = pr.checksStatus !== "failing";
  const showShip = reviewsReady && isOpen && checksOk;
  const hasActions = !!previewThread || !!pr.previewUrl || showShip;
  // Null-safe: react-query cache from before `checks` shipped can lack it.
  const checks = pr.checks ?? [];
  const hasChecksFooter = checks.length > 0 || checksHeader != null;
  const expandable = checks.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-3 card-shadow">
      <div className="flex items-center gap-3">
        <GitHubIcon className="size-4 shrink-0 text-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {pr.title ?? `${pr.repoOwner}/${pr.repoName}`}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-xs font-medium",
            style.className,
          )}
        >
          <style.icon size={13} />
          {style.label}
        </span>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={pr.url}
          className="group flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          #{pr.number}
          <LinkExternal01
            size={12}
            className="text-muted-foreground/60 group-hover:text-foreground"
          />
        </a>
      </div>
      {hasActions && (
        <div className="flex flex-wrap items-center gap-2">
          {previewThread && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              title={t("taskBoard.taskDialog.openPreviewTitle")}
              onClick={() => onOpenThread?.(previewThread)}
            >
              <Edit05 size={13} />
              {t("taskBoard.taskDialog.openPreviewButton")}
            </Button>
          )}
          {pr.previewUrl && (
            <Button
              asChild
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
            >
              <a href={pr.previewUrl} target="_blank" rel="noreferrer">
                <Globe01 size={14} />
                {t("taskBoard.taskDialog.previewLabel")}
                <LinkExternal01 size={12} />
              </a>
            </Button>
          )}
          {showShip && (
            <Button
              type="button"
              variant="success"
              size="sm"
              disabled={shipPending}
              onClick={onShip}
            >
              {t("taskBoard.taskDialog.shipToProductionButton")}
            </Button>
          )}
        </div>
      )}
      {hasChecksFooter && (
        <div className="border-t border-border pt-2 text-xs">
          <button
            type="button"
            disabled={!expandable}
            onClick={() => setChecksOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 font-medium disabled:cursor-default"
          >
            {checksHeader ? (
              <checksHeader.icon size={13} className={checksHeader.className} />
            ) : (
              <CheckCircle size={13} className="text-muted-foreground" />
            )}
            <span
              className={cn(checksHeader?.className ?? "text-muted-foreground")}
            >
              {checksHeader?.label ?? t("taskBoard.taskDialog.prChecksLabel")}
            </span>
            {expandable && (
              <ChevronRight
                size={14}
                className={cn(
                  "ml-auto text-muted-foreground/60 transition-transform",
                  checksOpen && "rotate-90",
                )}
              />
            )}
          </button>
          {checksOpen && (
            <div className="mt-2 flex flex-col gap-2">
              {checks.map((c) => {
                const cs = checkRunStyle(c);
                return (
                  <div key={c.name} className="rounded-md bg-muted/40 p-2">
                    <div className="flex items-center gap-2">
                      <cs.icon
                        size={13}
                        className={cn(
                          "shrink-0",
                          cs.className,
                          cs.spin && "animate-spin",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {c.name}
                      </span>
                      {c.detailsUrl && (
                        <a
                          href={c.detailsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-muted-foreground/60 hover:text-foreground"
                        >
                          <LinkExternal01 size={12} />
                        </a>
                      )}
                    </div>
                    {c.summary && (
                      <div className="mt-1.5 max-h-64 overflow-auto text-muted-foreground">
                        <MemoizedMarkdown
                          id={`${pr.url}-${c.name}`}
                          text={c.summary}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Placeholder card shown while the PR's live GitHub state (title/state/checks/
 *  preview) is still loading — the enrichment can take a moment. */
function PrCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-3 card-shadow">
      <div className="flex items-center gap-3">
        <Skeleton className="size-4 shrink-0 rounded" />
        <Skeleton className="h-4 min-w-0 flex-1" />
        <Skeleton className="h-4 w-16 shrink-0" />
        <Skeleton className="h-4 w-10 shrink-0" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-28" />
      </div>
    </div>
  );
}

/**
 * Links panel: the task's related pull requests (live GitHub state) plus any
 * links found in the description, aggregated in one place. Hidden when there's
 * nothing to show.
 */
function LinksSection({
  item,
  description,
  onOpenThread,
}: {
  item: TaskBoardItem;
  description: string;
  onOpenThread?: (thread: TaskBoardItemThread) => void;
}) {
  const t = useT();
  const { data: prs, isLoading: prsLoading } = useTaskBoardItemPrs(item.id);
  const { data: activity } = useTaskBoardActivity(item.id);
  const qaEnabled = useOrgFlag("qa_agent_enabled");
  const codeReviewerEnabled = useOrgFlag("code_reviewer_enabled");
  const promote = usePromoteToProduction(item.id);
  const links = extractDescriptionLinks(description);
  // Keep the section up (with a skeleton) while the PR enrichment loads; a
  // PR-less task resolves instantly, so the skeleton barely flashes for it.
  const loadingPrs = prsLoading && !prs;
  if (!loadingPrs && (!prs || prs.length === 0) && links.length === 0) {
    return null;
  }

  // Task-level readiness for the manual ship button: In Review + every enabled
  // reviewer approved. Shown regardless of auto-merge — it's a manual escape
  // hatch (a human can ship even while auto-merge is pending/blocked on token
  // verification). The per-card PrCard adds the PR-open + green-checks gate (so
  // a failing PR never offers the button).
  const reviewsReady =
    item.status === "in_review" &&
    reviewsSatisfiedForPromotion(
      activity ?? [],
      enabledReviewers({ qa: qaEnabled, codeReview: codeReviewerEnabled }),
    );
  const onShip = () =>
    promote.mutate(undefined, {
      onSuccess: (res) =>
        res?.merged
          ? toast.success(t("taskBoard.taskDialog.shipSuccess"))
          : toast.error(t("taskBoard.taskDialog.shipError")),
      onError: () => toast.error(t("taskBoard.taskDialog.shipError")),
    });

  // The task's preview-capable thread (a bound repo checked out on the PR's
  // branch). Opening it paints that branch's live dev server — so "Edit" lands
  // you in the branch, not on GitHub.
  const previewThread = onOpenThread
    ? item.threads.find((th) => th.hasPreview && th.virtualMcpId)
    : undefined;

  const row =
    "group flex items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-muted";

  return (
    <div className="flex flex-col gap-1 pb-2">
      <span className="mb-1 text-xs font-medium text-muted-foreground">
        {t("taskBoard.taskDialog.linksLabel")}
      </span>
      {loadingPrs ? (
        <PrCardSkeleton />
      ) : (
        (prs ?? []).map((pr) => (
          <PrCard
            key={pr.url}
            pr={pr}
            previewThread={previewThread}
            reviewsReady={reviewsReady}
            shipPending={promote.isPending}
            onShip={onShip}
            onOpenThread={onOpenThread}
          />
        ))
      )}
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className={row}
        >
          <Globe01 size={15} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {link.label}
          </span>
          <LinkExternal01
            size={13}
            className="shrink-0 text-muted-foreground/50 group-hover:text-foreground"
          />
        </a>
      ))}
    </div>
  );
}

/**
 * Activity feed: the task's change timeline (created, moved, (re)assigned), its
 * linked agent sessions and its comment threads, interleaved oldest-first.
 * Consecutive timeline events render as one run joined by a rail; a thread or a
 * comment renders as a card. A composer at the bottom starts a new thread.
 */
function ActivitySection({
  item,
  members,
  startedBy,
  onOpenThread,
}: {
  item: TaskBoardItem;
  members: Member[];
  startedBy?: Member;
  onOpenThread?: (thread: TaskBoardItemThread) => void;
}) {
  const t = useT();
  const { data: activity } = useTaskBoardActivity(item.id);
  const { data: session } = authClient.useSession();
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  const me: CommentAuthor = {
    id: session?.user?.id ?? "me",
    name: session?.user?.name ?? t("taskBoard.taskDialog.commentYouLabel"),
    image: session?.user?.image,
  };
  const comments = useTaskBoardComments(item.id);

  /** A comment's author, resolved from the org's members; falls back to the id
   *  so a comment from a since-removed member still renders. The Super Agent
   *  writes its own comments during a task run and is not a member, so it is
   *  resolved first — `isAgent` is what renders its glyph. */
  const authorOf = (userId: string): CommentAuthor => {
    if (userId === SUPER_AGENT_ASSIGNEE_ID) {
      return {
        id: userId,
        name: t("taskBoard.taskDialog.superAgentLabel"),
        isAgent: true,
      };
    }
    if (userId === me.id) return me;
    const member = memberByUserId.get(userId);
    return {
      id: userId,
      name: member?.user?.name ?? userId,
      image: member?.user?.image,
    };
  };
  const threads: TaskComment[] = comments.threads.map((thread) => ({
    id: thread.id,
    author: authorOf(thread.authorId),
    body: thread.body,
    createdAt: thread.createdAt,
    resolved: thread.resolved,
    replies: thread.replies.map((reply) => ({
      id: reply.id,
      author: authorOf(reply.authorId),
      body: reply.body,
      createdAt: reply.createdAt,
      replies: [],
    })),
  }));

  type Ev =
    | { kind: "activity"; at: number; activity: TaskBoardActivity }
    | { kind: "thread"; at: number; thread: TaskBoardItemThread }
    | { kind: "comment"; at: number; comment: TaskComment };
  const events: Ev[] = [
    ...(activity ?? []).map(
      (a): Ev => ({
        kind: "activity",
        at: new Date(a.occurredAt).getTime(),
        activity: a,
      }),
    ),
    ...item.threads.map(
      (thread): Ev => ({
        kind: "thread",
        at: new Date(thread.createdAt).getTime(),
        thread,
      }),
    ),
    ...threads.map(
      (comment): Ev => ({
        kind: "comment",
        at: new Date(comment.createdAt).getTime(),
        comment,
      }),
    ),
  ].sort((a, b) => a.at - b.at);

  // Group consecutive timeline events so their avatars connect with a rail.
  const blocks: (
    | { type: "timeline"; items: TaskBoardActivity[] }
    | { type: "thread"; thread: TaskBoardItemThread }
    | { type: "comment"; comment: TaskComment }
  )[] = [];
  for (const ev of events) {
    if (ev.kind === "thread") {
      blocks.push({ type: "thread", thread: ev.thread });
      continue;
    }
    if (ev.kind === "comment") {
      blocks.push({ type: "comment", comment: ev.comment });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.type === "timeline") last.items.push(ev.activity);
    else blocks.push({ type: "timeline", items: [ev.activity] });
  }

  return (
    <div className="flex flex-col gap-5 pb-2">
      <span className="text-sm font-medium text-foreground">
        {t("taskBoard.taskDialog.activityLabel")}
      </span>

      {blocks.map((block, i) => {
        if (block.type === "timeline") {
          return (
            <TimelineBlock
              // Blocks are positional runs of the same feed, so the index IS
              // the identity here — there's no stabler key for a group.
              key={`timeline-${i}`}
              items={block.items}
              memberByUserId={memberByUserId}
            />
          );
        }
        if (block.type === "comment") {
          return (
            <CommentThreadCard
              key={`comment-${block.comment.id}`}
              thread={block.comment}
              me={me}
              onReply={(body) =>
                comments.post.mutate({ body, parentId: block.comment.id })
              }
              onDelete={(commentId) => comments.remove.mutate(commentId)}
              onToggleResolved={() =>
                comments.setResolved.mutate({
                  id: block.comment.id,
                  resolved: !block.comment.resolved,
                })
              }
            />
          );
        }
        return (
          <ThreadActivityItem
            key={`thread-${block.thread.threadId}`}
            thread={block.thread}
            startedBy={startedBy}
            onOpen={onOpenThread}
          />
        );
      })}

      <NewCommentComposer
        me={me}
        onSubmit={(body) => comments.post.mutate({ body })}
      />
    </div>
  );
}

/**
 * A value named by a timeline line, carrying the same glyph the board uses for
 * it (status icon, priority dot, assignee avatar, calendar) so the line reads at
 * a glance.
 *
 * The label is plain inline text, so it shares the sentence's baseline instead
 * of inheriting one synthesized from a wrapper box. Only the glyph is an atomic
 * inline box, sized to exactly one line-height and top-aligned: it spans the
 * line box precisely, so it can never make the row taller, and centering within
 * it puts the glyph on the middle of the cap-height band — Inter's ascent minus
 * descent equals its cap height, so the line box's midpoint IS the cap band's.
 * Give glyphs an even pixel size to keep them on whole pixels.
 */
function ValueChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <>
      <span className="ml-1 mr-1 inline-flex h-[1lh] items-center align-top">
        {icon}
      </span>
      <span className="mr-1">{label}</span>
    </>
  );
}

/**
 * Slot a chip into the sentence where `t()` interpolated its placeholder.
 *
 * Sentences stay single translatable strings (`"moved from {from} to {to}"`);
 * we interpolate a sentinel for each value, then split on it and drop the chip
 * in. Keyed by name, not position, so a translation that reorders the
 * placeholders still pairs each chip with its own value.
 */
const SENTINEL = "\u0000";

function chipSentinel(name: string): string {
  return `${SENTINEL}${name}${SENTINEL}`;
}

function interleaveChips(
  text: string,
  chips: Record<string, ReactNode>,
): ReactNode {
  // Capturing split → even indices are literal text, odd ones are chip names.
  return text
    .split(new RegExp(`${SENTINEL}(\\w+)${SENTINEL}`))
    .map((part, i) => (
      <Fragment key={i}>{i % 2 === 0 ? part : chips[part]}</Fragment>
    ));
}

/** One timeline line: prose from `t()`, values rendered as chips. */
/** Display name for a reviewer kind stored in an activity payload. */
function reviewerName(reviewer: unknown, t: ReturnType<typeof useT>): string {
  return reviewer === "code_review"
    ? t("taskBoard.taskDialog.codeReviewerLabel")
    : t("taskBoard.taskDialog.qaAgentLabel");
}

function describeActivity(
  a: TaskBoardActivity,
  t: ReturnType<typeof useT>,
  memberByUserId: Map<string, Member>,
): ReactNode {
  const statusChip = (s: unknown) => {
    const cfg =
      typeof s === "string"
        ? STATUS_CONFIG[s as keyof typeof STATUS_CONFIG]
        : undefined;
    if (!cfg) return String(s ?? "");
    const Icon = cfg.icon;
    return (
      <ValueChip
        icon={<Icon size={14} className={cfg.iconClassName} />}
        label={t(cfg.labelKey)}
      />
    );
  };
  const priorityChip = (p: unknown) => {
    const cfg =
      typeof p === "string"
        ? PRIORITY_CONFIG[p as keyof typeof PRIORITY_CONFIG]
        : undefined;
    if (!cfg) return String(p ?? "");
    return (
      <ValueChip
        icon={<span className={cn("size-2 rounded-full", cfg.dotClassName)} />}
        label={t(cfg.labelKey)}
      />
    );
  };
  const dateChip = (iso: unknown) => {
    const date = parseIsoDate(typeof iso === "string" ? iso : null);
    if (!date) return "";
    return (
      <ValueChip
        icon={<Calendar size={14} className="text-muted-foreground" />}
        label={DUE_DATE_FMT.format(date)}
      />
    );
  };
  const tagsChip = (tags: unknown): ReactNode => {
    if (!Array.isArray(tags) || tags.length === 0) return null;
    return tags.map((tag, i) => {
      const ref = tag as { id?: string; name?: string; color?: string | null };
      return (
        <ValueChip
          key={ref.id ?? i}
          icon={
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: tagDotColor(ref.color) }}
            />
          }
          label={ref.name ?? ""}
        />
      );
    });
  };
  const assigneeChip = (userId: unknown) => {
    if (userId === SUPER_AGENT_ASSIGNEE_ID) {
      return (
        <ValueChip
          icon={<SuperAgentIcon size={14} />}
          label={t("taskBoard.taskDialog.superAgentLabel")}
        />
      );
    }
    const member =
      typeof userId === "string" ? memberByUserId.get(userId) : undefined;
    return (
      <ValueChip
        icon={
          <Avatar
            url={member?.user?.image ?? undefined}
            fallback={getInitials(member?.user?.name)}
            shape="circle"
            size="2xs"
          />
        }
        label={member?.user?.name ?? t("taskBoard.taskDialog.someoneLabel")}
      />
    );
  };
  const reviewerChip = (reviewer: unknown) => (
    <ValueChip
      icon={
        reviewer === "code_review" ? (
          <CodeReviewerIcon size={14} />
        ) : (
          <QaAgentIcon size={14} />
        )
      }
      label={reviewerName(reviewer, t)}
    />
  );

  const d = a.data;
  const from = chipSentinel("from");
  const to = chipSentinel("to");
  switch (a.action) {
    case "created":
      return t("taskBoard.taskDialog.activityCreated");
    case "status_changed":
      return interleaveChips(
        d.from
          ? t("taskBoard.taskDialog.activityMovedFromTo", { from, to })
          : t("taskBoard.taskDialog.activityMovedTo", { to }),
        { from: statusChip(d.from), to: statusChip(d.to) },
      );
    case "assignee_changed":
      if (d.to == null) return t("taskBoard.taskDialog.activityUnassigned");
      return interleaveChips(
        t(
          d.to === SUPER_AGENT_ASSIGNEE_ID
            ? "taskBoard.taskDialog.activityDelegated"
            : "taskBoard.taskDialog.activityAssigned",
          { name: chipSentinel("name") },
        ),
        { name: assigneeChip(d.to) },
      );
    // "none" is priority's unset value, so it reads as a set/clear, not a move.
    case "priority_changed":
      if (d.to === "none")
        return t("taskBoard.taskDialog.activityPriorityCleared");
      return interleaveChips(
        !d.from || d.from === "none"
          ? t("taskBoard.taskDialog.activityPrioritySet", { to })
          : t("taskBoard.taskDialog.activityPriorityFromTo", { from, to }),
        { from: priorityChip(d.from), to: priorityChip(d.to) },
      );
    case "due_date_changed":
      if (d.to == null) return t("taskBoard.taskDialog.activityDueDateCleared");
      return interleaveChips(
        d.from == null
          ? t("taskBoard.taskDialog.activityDueDateSet", { to })
          : t("taskBoard.taskDialog.activityDueDateFromTo", { from, to }),
        { from: dateChip(d.from), to: dateChip(d.to) },
      );
    case "title_changed":
      return t("taskBoard.taskDialog.activityRenamed", {
        to: String(d.to ?? ""),
      });
    case "description_changed":
      return t("taskBoard.taskDialog.activityDescriptionUpdated");
    case "tags_changed":
      if (!Array.isArray(d.to) || d.to.length === 0)
        return t("taskBoard.taskDialog.activityTagsCleared");
      return interleaveChips(
        t("taskBoard.taskDialog.activityTagsSet", { to }),
        {
          to: tagsChip(d.to),
        },
      );
    case "review_requested":
      return interleaveChips(
        t("taskBoard.taskDialog.activityDelegated", {
          name: chipSentinel("name"),
        }),
        { name: reviewerChip(d.reviewer) },
      );
    case "review_approved":
      return typeof d.notes === "string" && d.notes.trim()
        ? t("taskBoard.taskDialog.activityReviewApprovedWithNotes", {
            reviewer: reviewerName(d.reviewer, t),
            notes: d.notes,
          })
        : t("taskBoard.taskDialog.activityReviewApproved", {
            reviewer: reviewerName(d.reviewer, t),
          });
    case "review_changes_requested":
      return typeof d.notes === "string" && d.notes.trim()
        ? t("taskBoard.taskDialog.activityReviewChangesRequestedWithNotes", {
            reviewer: reviewerName(d.reviewer, t),
            notes: d.notes,
          })
        : t("taskBoard.taskDialog.activityReviewChangesRequested", {
            reviewer: reviewerName(d.reviewer, t),
          });
    case "merge_conflict_resolution":
      return t("taskBoard.taskDialog.activityMergeConflictResolution");
    case "merge_failed": {
      // `detail` names the repo (no_connection) or carries GitHub's refusal
      // text — the difference between "it's broken" and "connect this repo".
      const detail = typeof d.detail === "string" ? d.detail : "";
      switch (d.reason) {
        case "no_pr":
          return t("taskBoard.taskDialog.activityMergeFailedNoPr");
        case "checks_failing":
          return t("taskBoard.taskDialog.activityMergeFailedChecksFailing");
        case "no_connection":
          return detail
            ? t("taskBoard.taskDialog.activityMergeFailedNoConnection", {
                detail,
              })
            : t("taskBoard.taskDialog.activityMergeFailed");
        case "rate_limited":
          return t("taskBoard.taskDialog.activityMergeFailedRateLimited");
        case "refused":
          return detail
            ? t("taskBoard.taskDialog.activityMergeFailedRefused", { detail })
            : t("taskBoard.taskDialog.activityMergeFailed");
        default:
          return detail
            ? t("taskBoard.taskDialog.activityMergeFailedError", { detail })
            : t("taskBoard.taskDialog.activityMergeFailed");
      }
    }
    default: {
      const _exhaustive: never = a.action;
      return String(_exhaustive);
    }
  }
}

/** True for the machine actor behind an agent-driven change — the log stores a
 *  null actor for those. */
function isMachineActor(actorId: string | null): boolean {
  return !actorId || actorId === SUPER_AGENT_ASSIGNEE_ID;
}

/** A run of consecutive timeline events, avatars joined by a vertical rail. */
function TimelineBlock({
  items,
  memberByUserId,
}: {
  items: TaskBoardActivity[];
  memberByUserId: Map<string, Member>;
}) {
  const t = useT();

  const actorName = (actorId: string | null) => {
    if (isMachineActor(actorId)) {
      return t("taskBoard.taskDialog.superAgentLabel");
    }
    return (
      memberByUserId.get(actorId!)?.user?.name ??
      t("taskBoard.taskDialog.someoneLabel")
    );
  };

  const actorAvatar = (actorId: string | null): ReactNode => {
    if (isMachineActor(actorId)) {
      return (
        <span className="z-10 flex size-4 shrink-0 items-center justify-center bg-background">
          <SuperAgentIcon size={16} />
        </span>
      );
    }
    const member = memberByUserId.get(actorId!);
    return (
      <span className="z-10 shrink-0 rounded-full bg-background">
        <Avatar
          url={member?.user?.image ?? undefined}
          fallback={getInitials(member?.user?.name)}
          shape="circle"
          size="2xs"
        />
      </span>
    );
  };

  return (
    <div className="relative flex flex-col gap-4">
      {items.length > 1 && (
        <span
          aria-hidden
          className="absolute bottom-3 left-2 top-3 w-px bg-border"
        />
      )}
      {items.map((a) => (
        <div key={a.id} className="relative flex items-center gap-2.5">
          {actorAvatar(a.actorId)}
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {actorName(a.actorId)}
            </span>{" "}
            {describeActivity(a, t, memberByUserId)}
            <span className="text-muted-foreground/60">
              {" · "}
              {formatTimeAgo(new Date(a.occurredAt))}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
