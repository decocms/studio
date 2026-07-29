import { Fragment, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Calendar as DayPickerCalendar } from "@deco/ui/components/calendar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { useCopy } from "@deco/ui/hooks/use-copy.ts";
import {
  AlertCircle,
  AlertSquare,
  Calendar,
  Check,
  CheckCircle,
  ChevronRight,
  Copy01,
  DotsHorizontal,
  Edit05,
  GitMerge,
  GitPullRequest,
  Globe01,
  HelpCircle,
  LinkExternal01,
  Loading02,
  Plus,
  Tag01,
  Trash03,
  UserPlus01,
  X,
} from "@untitledui/icons";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { useMembers } from "@/hooks/use-members";
import { useCreateTag, useDeleteTag, useTags } from "@/hooks/use-tags";
import { getInitials } from "@/lib/get-initials";
import { useT } from "@/i18n/use-t.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  nextTagColor,
  PRIORITIES,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  SUPER_AGENT_ASSIGNEE_ID,
  tagDotColor,
  type Member,
  type TaskBoardItem,
  type TaskBoardItemPr,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type TaskBoardItemThread,
} from "./config";
import { useTaskBoardItemPrs } from "@/hooks/use-task-board-item-prs";
import {
  useTaskBoardActivity,
  type TaskBoardActivity,
} from "@/hooks/use-task-board-activity";
import { formatTimeAgo } from "@/lib/format-time";
import { GitHubIcon } from "@/components/icons/github-icon";
import { AssigneePickerContent } from "./assignee-picker";
import { TagPickerContent } from "./tag-picker";

// ponytail: pinned to end-of-day so "due today" doesn't flip to overdue
// mid-morning. Local zone in, UTC out.
function toEndOfDayIso(d: Date): string {
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

export function TaskBoardItemDialog({
  open,
  onClose,
  item,
  defaultStatus,
  onSubmit,
  onDelete,
  onOpenThread,
  onNewChat,
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
    dueDate: string | null;
    tagIds: string[];
  }) => void;
  onDelete?: () => void;
  onOpenThread?: (thread: TaskBoardItemThread) => void;
  /** Edit mode only: start a fresh chat seeded with this task as context. */
  onNewChat?: () => void;
  isSaving?: boolean;
}) {
  const t = useT();
  const { data } = useMembers();
  const members = (data?.data?.members ?? []) as Member[];
  const { handleCopy, copied } = useCopy();
  const { data: orgTags = [] } = useTags();
  const createTag = useCreateTag();
  const deleteTag = useDeleteTag();

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
      dueDate: dueDate ? toEndOfDayIso(dueDate) : null,
      tagIds,
    });
  };

  const isSuperAgent = assigneeId === SUPER_AGENT_ASSIGNEE_ID;
  const assignee = members.find((m) => m.userId === assigneeId);
  const assignedBy = item?.assignedBy
    ? members.find((m) => m.userId === item.assignedBy)
    : undefined;
  const StatusIcon = STATUS_CONFIG[status].icon;

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
                view — the title is the one thing that should stay put. */}
            <div className="sticky top-0 z-10 bg-background p-6 pb-0 sm:p-8 sm:pb-0">
              <textarea
                ref={(el) => {
                  if (!el) return;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                value={title}
                onChange={(e) => {
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
                className="w-full resize-none overflow-hidden border-0 bg-transparent text-xl font-medium leading-snug text-foreground outline-none placeholder:text-foreground/30"
              />
            </div>

            <div className="flex flex-col gap-6 p-6 pt-6 sm:p-8 sm:pt-6">
              <div className="group relative flex flex-col">
                {/* Hugs its content (same auto-grow as the title) so a long
                    description is never clipped behind an inner scrollbar — the
                    pane scrolls instead. */}
                <textarea
                  ref={(el) => {
                    if (!el) return;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${e.target.scrollHeight}px`;
                  }}
                  placeholder={t("taskBoard.taskDialog.descriptionPlaceholder")}
                  className="min-h-[200px] w-full resize-none overflow-hidden border-0 bg-transparent text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50 sm:min-h-[320px]"
                />
                {description && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t(
                      "taskBoard.taskDialog.copyDescriptionAriaLabel",
                    )}
                    className="absolute right-0 top-0 size-7 rounded-md border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100"
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
                      className={STATUS_CONFIG[status].iconClassName}
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
                    className={cn(
                      PROPERTY_BUTTON,
                      priority === "none" && "text-muted-foreground",
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
                        setAssigneeId(userId);
                        setAssigneeOpen(false);
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Live-status style for a linked thread (agent session). */
function threadStatusStyle(
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

  return (
    <button
      type="button"
      disabled={!onOpen}
      onClick={() => onOpen?.(thread)}
      className="group flex w-full flex-col gap-2 rounded-xl bg-card p-4 text-left card-shadow transition-colors enabled:hover:bg-muted/60 disabled:cursor-default"
    >
      <div className="flex items-center gap-2">
        <SuperAgentIcon size={16} className="shrink-0" />
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

/** Extract outbound links from the description text — bare URLs, deduped, for
 *  the Links panel. */
function extractDescriptionLinks(
  text: string,
): { url: string; label: string }[] {
  if (!text) return [];
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)]+/g)) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label: url });
  }
  return out;
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
  const { data: prs } = useTaskBoardItemPrs(item.id);
  const links = extractDescriptionLinks(description);
  if ((!prs || prs.length === 0) && links.length === 0) return null;

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
      {(prs ?? []).map((pr) => {
        const style = prStateStyle(pr, t);
        return (
          <div
            key={pr.url}
            className="flex items-center gap-3 rounded-xl bg-card p-3 card-shadow"
          >
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="group flex min-w-0 flex-1 items-center gap-3"
            >
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
              <span className="shrink-0 text-xs text-muted-foreground">
                #{pr.number}
              </span>
              <LinkExternal01
                size={13}
                className="shrink-0 text-muted-foreground/50 group-hover:text-foreground"
              />
            </a>
            {previewThread && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 gap-1.5 px-2"
                title={t("taskBoard.taskDialog.openPreviewTitle")}
                onClick={() => onOpenThread?.(previewThread)}
              >
                <Edit05 size={13} />
                {t("taskBoard.taskDialog.openPreviewButton")}
              </Button>
            )}
          </div>
        );
      })}
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
 * Activity feed: the task's change timeline (created, moved, (re)assigned) and
 * its linked agent sessions, interleaved oldest-first. Consecutive timeline
 * events render as one run joined by a rail; a thread renders as a card.
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
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  type Ev =
    | { kind: "activity"; at: number; activity: TaskBoardActivity }
    | { kind: "thread"; at: number; thread: TaskBoardItemThread };
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
  ].sort((a, b) => a.at - b.at);

  if (events.length === 0) return null;

  // Group consecutive timeline events so their avatars connect with a rail.
  const blocks: (
    | { type: "timeline"; items: TaskBoardActivity[] }
    | { type: "thread"; thread: TaskBoardItemThread }
  )[] = [];
  for (const ev of events) {
    if (ev.kind === "thread") {
      blocks.push({ type: "thread", thread: ev.thread });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.type === "timeline") last.items.push(ev.activity);
    else blocks.push({ type: "timeline", items: [ev.activity] });
  }

  return (
    <div className="flex flex-col gap-5 pb-2">
      <span className="text-sm font-medium text-muted-foreground">
        {t("taskBoard.taskDialog.activityLabel")}
      </span>
      {blocks.map((block, i) =>
        block.type === "timeline" ? (
          <TimelineBlock
            // Blocks are positional runs of the same feed, so the index IS the
            // identity here — there's no stabler key for a group.
            key={`timeline-${i}`}
            items={block.items}
            memberByUserId={memberByUserId}
          />
        ) : (
          <ThreadActivityItem
            key={`thread-${block.thread.threadId}`}
            thread={block.thread}
            startedBy={startedBy}
            onOpen={onOpenThread}
          />
        ),
      )}
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
