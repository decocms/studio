import { useRef, useState, type ReactNode } from "react";
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
import {
  AlertCircle,
  AlertSquare,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Attachment01,
  Calendar,
  Check,
  CheckCircle,
  ChevronRight,
  Circle,
  DotsHorizontal,
  Edit05,
  File02,
  GitMerge,
  GitPullRequest,
  Globe01,
  HelpCircle,
  LinkExternal01,
  Loading02,
  Plus,
  RefreshCw01,
  SearchMd,
  Tag01,
  Trash03,
  UserPlus01,
  X,
} from "@untitledui/icons";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { useMembers } from "@/hooks/use-members";
import { getInitials } from "@/lib/get-initials";
import { useT } from "@/i18n/use-t.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  columnForItem,
  columnLabel,
  formatSprintRange,
  formatTaskKey,
  generateSprintWeeks,
  labelDotColor,
  movePayload,
  PRIORITIES,
  sprintStateLabelKey,
  sprintStateTone,
  sprintWeekState,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  SUPER_AGENT_ASSIGNEE_ID,
  useBoardColumns,
  type BoardColumn,
  type Member,
  type TaskBoardItem,
  type TaskBoardItemPr,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type TaskBoardItemThread,
} from "./config";
import { useTaskBoardItemPrs } from "@/hooks/use-task-board-item-prs";
import { useTaskBoardItems } from "@/hooks/use-task-board-items";
import { useTaskBoardSettings } from "@/hooks/use-organization-settings";
import {
  useTaskBoardActivity,
  type TaskBoardActivity,
} from "@/hooks/use-task-board-activity";
import {
  taskBoardAttachmentUrl,
  useTaskBoardAttachments,
  useTaskBoardCommentActions,
  useTaskBoardComments,
  type TaskBoardAttachment,
  type TaskBoardComment,
} from "@/hooks/use-task-board-comments";
import { useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import { formatTimeAgo } from "@/lib/format-time";
import { toast } from "sonner";
import { Node } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { AssigneePickerContent } from "./assignee-picker";
import { GitHubIcon } from "@/components/icons/github-icon";

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

// ponytail: THREAD_STATUS labels moved into component to access t()
// each status key is resolved dynamically via t() in ActivityCard

export function TaskBoardItemDialog({
  open,
  onClose,
  item,
  defaultColumn,
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
  /** In create mode, the column to start the new task in (e.g. the lane the
   * "+" was clicked from). Falls back to the first column. */
  defaultColumn?: BoardColumn;
  onSubmit: (input: {
    title: string;
    description: string | null;
    status: TaskBoardItemStatus;
    columnId: string | null;
    priority: TaskBoardItemPriority;
    assigneeId: string | null;
    dueDate: string | null;
    tags: string[];
    sprintId: string | null;
  }) => void;
  onDelete?: () => void;
  onOpenThread?: (thread: TaskBoardItemThread) => void;
  /** Edit mode only: start a fresh chat seeded with this task as context. */
  onNewChat?: () => void;
  isSaving?: boolean;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { data } = useMembers();
  const members = (data?.data?.members ?? []) as Member[];

  const columns = useBoardColumns();
  const boardSettings = useTaskBoardSettings();
  const sprintsEnabled = boardSettings?.sprintsEnabled ?? false;
  // Upload a file as a task attachment and return its served URL, so a file
  // pasted/dropped into the description can be embedded inline (image) or
  // linked (other files). Only wired once the task exists (an attachment needs
  // a task id). Returns null on skip/failure.
  const attachmentActions = useTaskBoardCommentActions(item?.id);
  const uploadFile = async (
    file: File,
  ): Promise<{ url: string; isImage: boolean } | null> => {
    if (!item?.id) return null;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(
        t("taskBoard.taskDialog.attachmentTooLarge", { name: file.name }),
      );
      return null;
    }
    try {
      const { attachment } = await attachmentActions.addAttachment.mutateAsync({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: await fileToBase64(file),
      });
      return {
        url: taskBoardAttachmentUrl(org.slug, attachment.id),
        isImage: (file.type || "").startsWith("image/"),
      };
    } catch {
      toast.error(
        t("taskBoard.taskDialog.attachmentUploadFailed", { name: file.name }),
      );
      return null;
    }
  };

  const initialColumn = item
    ? columnForItem(item, columns)
    : (defaultColumn ?? columns[0]!);

  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [column, setColumn] = useState<BoardColumn>(initialColumn);
  const [priority, setPriority] = useState<TaskBoardItemPriority>(
    item?.priority ?? "medium",
  );
  const [assigneeId, setAssigneeId] = useState<string | null>(
    item?.assigneeId ?? null,
  );
  const [dueDate, setDueDate] = useState<Date | null>(
    parseIsoDate(item?.dueDate),
  );
  const [tags, setTags] = useState<string[]>(item?.tags ?? []);
  const [sprintId, setSprintId] = useState<string | null>(
    item?.sprintId ?? null,
  );
  // System-defined weeks to pick from; if the task's week is outside the
  // window, keep it selectable by prepending it.
  const sprintWeeks =
    sprintId && !generateSprintWeeks().includes(sprintId)
      ? [sprintId, ...generateSprintWeeks()]
      : generateSprintWeeks();
  const [dueOpen, setDueOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);

  const reset = () => {
    setTitle(item?.title ?? "");
    setDescription(item?.description ?? "");
    setColumn(initialColumn);
    setPriority(item?.priority ?? "medium");
    setAssigneeId(item?.assigneeId ?? null);
    setDueDate(parseIsoDate(item?.dueDate));
    setTags(item?.tags ?? []);
    setSprintId(item?.sprintId ?? null);
  };

  const close = () => {
    onClose();
    reset();
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSubmit({
      title: trimmed,
      description: description.trim() || null,
      ...movePayload(column),
      priority,
      assigneeId,
      dueDate: dueDate ? toEndOfDayIso(dueDate) : null,
      tags,
      sprintId,
    });
  };

  const isSuperAgent = assigneeId === SUPER_AGENT_ASSIGNEE_ID;
  const assignee = members.find((m) => m.userId === assigneeId);
  const assignedBy = item?.assignedBy
    ? members.find((m) => m.userId === item.assignedBy)
    : undefined;
  const StatusIcon = STATUS_CONFIG[column.stage].icon;

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

        {/* One scroll container for the whole body — editor content and the
            properties sidebar live inside it, so the description, attachments
            and comments scroll together. Nothing gets its own inner scroll or
            fills the height, so a long description just extends the scroll. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row sm:items-stretch">
          {/* Editor pane — content flows; no inner scroll (the row scrolls). */}
          <div className="flex min-w-0 flex-col gap-4 p-6 sm:flex-1 sm:p-8">
            {/* Short key ("OS-42"), the way trackers surface PROJ-123. Edit
                mode only — a new task has no number until it's created. */}
            {item && formatTaskKey(org.slug, item.seq) && (
              <span className="font-mono text-xs text-muted-foreground">
                {formatTaskKey(org.slug, item.seq)}
                {item.externalKey ? ` · ${item.externalKey}` : ""}
              </span>
            )}

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

            <DescriptionField
              value={description}
              onChange={setDescription}
              canEmbed={!!item?.id}
              uploadFile={uploadFile}
              placeholder={t("taskBoard.taskDialog.descriptionPlaceholder")}
            />

            {item && <hr className="border-border" />}

            {item?.id && (
              <LinksSection
                item={item}
                description={description}
                onOpenThread={onOpenThread}
              />
            )}

            {item?.id && <AttachmentsCard itemId={item.id} />}

            {item && (
              <ActivitySection
                item={item}
                members={members}
                startedBy={assignedBy ?? assignee}
                onOpenThread={onOpenThread}
              />
            )}
          </div>

          {/* Properties pane — wrapping chips under the editor on mobile; on
              desktop a sidebar that sticks to the top so it stays visible while
              a long description scrolls past. */}
          <div className="flex w-full shrink-0 flex-col gap-4 border-t border-border p-6 sm:sticky sm:top-0 sm:w-[220px] sm:border-t-0 sm:border-l sm:px-6 sm:py-10">
            <span className="hidden px-3 text-sm text-muted-foreground sm:block">
              {t("taskBoard.taskDialog.propertiesLabel")}
            </span>

            <div className="flex flex-wrap gap-2 sm:flex-col">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={PROPERTY_BUTTON}>
                    <StatusIcon
                      size={16}
                      className={STATUS_CONFIG[column.stage].iconClassName}
                    />
                    {columnLabel(column, t)}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  {columns.map((c) => {
                    const Icon = STATUS_CONFIG[c.stage].icon;
                    return (
                      <DropdownMenuItem
                        key={c.id}
                        onSelect={() => setColumn(c)}
                        className="gap-2"
                      >
                        <Icon
                          size={16}
                          className={STATUS_CONFIG[c.stage].iconClassName}
                        />
                        {columnLabel(c, t)}
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

              {sprintsEnabled && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        PROPERTY_BUTTON,
                        !sprintId && "text-muted-foreground",
                      )}
                    >
                      <RefreshCw01
                        size={16}
                        className="text-muted-foreground"
                      />
                      <span className="truncate">
                        {sprintId
                          ? formatSprintRange(sprintId)
                          : t("taskBoard.taskDialog.sprintLabel")}
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="max-h-80 w-72 overflow-y-auto"
                  >
                    <DropdownMenuItem
                      onSelect={() => setSprintId(null)}
                      className="gap-2"
                    >
                      <Check
                        size={14}
                        className={cn("shrink-0", sprintId && "opacity-0")}
                      />
                      {t("taskBoard.taskDialog.sprintNone")}
                    </DropdownMenuItem>
                    {sprintWeeks.map((week) => {
                      const state = sprintWeekState(week);
                      return (
                        <DropdownMenuItem
                          key={week}
                          onSelect={() => setSprintId(week)}
                          className="gap-2"
                        >
                          <Check
                            size={14}
                            className={cn(
                              "shrink-0",
                              sprintId !== week && "opacity-0",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {formatSprintRange(week)}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 text-xs",
                              sprintStateTone(state),
                            )}
                          >
                            {t(sprintStateLabelKey(state))}
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <TagsEditor tags={tags} onChange={setTags} />
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
              <Plus size={16} />
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
 * A linked agent session (thread) in the Activity feed — the WHOLE card is
 * clickable (opens the run's chat), with a hover state + "Open" affordance so
 * it's obvious it's interactive, plus the live run status and last message.
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

/** Extract outbound links from the description HTML — anchors plus bare URLs —
 *  deduped, for the Links panel. (Inline images use relative `/api/...` src and
 *  aren't anchors, so they're excluded.) */
function extractDescriptionLinks(
  html: string,
): { url: string; label: string }[] {
  if (!html) return [];
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  const push = (url: string, label: string) => {
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label: label.trim() || url });
  };
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("a[href]")
    .forEach((a) => push(a.getAttribute("href") ?? "", a.textContent ?? ""));
  for (const m of (doc.body.textContent ?? "").matchAll(
    /https?:\/\/[^\s)]+/g,
  )) {
    push(m[0], m[0]);
  }
  return out;
}

/**
 * Links panel (ai-services-panel style): the task's related pull requests plus
 * any links found in the description, aggregated in one place — distinct from
 * the activity timeline. Hidden when there's nothing to show.
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
  // branch). Opening it with `main: "preview"` paints that branch's live dev
  // server — so "Edit" lands you in the branch, not on GitHub.
  const previewThread = onOpenThread
    ? item.threads.find((th) => th.hasPreview && th.virtualMcpId)
    : undefined;

  const row =
    "group flex items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-muted";
  const external = (
    <LinkExternal01
      size={13}
      className="shrink-0 text-muted-foreground/50 group-hover:text-foreground"
    />
  );

  return (
    <div className="flex flex-col gap-1 pb-4">
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
          {external}
        </a>
      ))}
    </div>
  );
}

/** Free-form tag chips with an inline "add" input (Enter or comma commits). */
/**
 * Tags property control — a PROPERTY_BUTTON row matching the status/assignee/
 * due/sprint controls: the trigger shows the current tags (or a muted "Tags"
 * placeholder), and a popover holds the removable chips + an add input.
 */
/**
 * Labels control (Linear-style): selected labels render as colored-dot pills,
 * an "Add label" pill opens a searchable picker of labels already used across
 * the board, and typing a new name creates one on the fly.
 */
function TagsEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { items } = useTaskBoardItems();

  const allLabels = [...new Set(items.flatMap((i) => i.tags))].sort();
  const q = query.trim();
  // Show every known label (selected + not), filtered by the query — a toggle
  // list with checkmarks, like Linear's label picker.
  const filtered = allLabels.filter((l) =>
    l.toLowerCase().includes(q.toLowerCase()),
  );
  const canCreate =
    q.length > 0 && !allLabels.some((l) => l.toLowerCase() === q.toLowerCase());

  const toggle = (label: string) => {
    onChange(
      tags.includes(label) ? tags.filter((x) => x !== label) : [...tags, label],
    );
  };
  const create = (label: string) => {
    if (!tags.includes(label)) onChange([...tags, label]);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      modal
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            PROPERTY_BUTTON,
            tags.length === 0 && "text-muted-foreground",
          )}
        >
          <Tag01 size={16} className="text-muted-foreground" />
          {tags.length === 0 ? (
            t("taskBoard.taskDialog.addLabelButton")
          ) : tags.length === 1 ? (
            <>
              <span
                className={cn("size-2 rounded-full", labelDotColor(tags[0]!))}
              />
              <span className="truncate">{tags[0]}</span>
            </>
          ) : (
            <>
              <span
                className={cn("size-2 rounded-full", labelDotColor(tags[0]!))}
              />
              <span className="truncate">{tags[0]}</span>
              <span className="text-muted-foreground">+{tags.length - 1}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-border px-2.5">
          <SearchMd size={14} className="shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (filtered[0]) toggle(filtered[0]);
              else if (canCreate) create(q);
            }}
            placeholder={t("taskBoard.taskDialog.addLabelsPlaceholder")}
            autoFocus
            className="h-9 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.map((label) => {
            const selected = tags.includes(label);
            return (
              <button
                key={label}
                type="button"
                onClick={() => toggle(label)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
              >
                <span
                  className={cn(
                    "size-2.5 shrink-0 rounded-full",
                    labelDotColor(label),
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <Check
                  size={14}
                  className={cn(
                    "shrink-0 text-foreground",
                    !selected && "opacity-0",
                  )}
                />
              </button>
            );
          })}
          {canCreate && (
            <button
              type="button"
              onClick={() => create(q)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
            >
              <Plus size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {t("taskBoard.taskDialog.createLabelOption", { label: q })}
              </span>
            </button>
          )}
          {filtered.length === 0 && !canCreate && (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {t("taskBoard.taskDialog.noLabelsFound")}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read a File into base64 (no data-URL prefix) for the upload tools. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
/** Inline image node (URL-based) so pasted/dropped images stay rendered as
 *  images while you edit the text around them — round-trips via `<img src>`. */
const DescriptionImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: null }, alt: { default: null } };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", HTMLAttributes];
  },
});

/** Seed the editor from a stored value: new descriptions are HTML; legacy ones
 *  are markdown-ish text — convert `![](url)` + paragraphs so they still show
 *  as images rather than raw markdown. */
function descriptionToHtml(value: string): string {
  if (!value) return "";
  if (/^\s*<[a-z]/i.test(value)) return value; // already HTML
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return value
    .split(/\n{2,}/)
    .map(
      (block) =>
        `<p>${esc(block)
          .replace(
            /!\[([^\]]*)\]\(([^)\s]+)\)/g,
            (_m, alt, src) => `</p><img src="${src}" alt="${alt}"><p>`,
          )
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("")
    .replace(/<p><\/p>/g, "");
}

/**
 * Description editor — a WYSIWYG (tiptap) field, NOT a markdown textarea, so a
 * pasted/dropped image stays a rendered image while you keep editing the text
 * around it (never condensing into raw `![](…)` markdown). Stored as HTML.
 * Uncontrolled after mount (the dialog remounts per task via its key), so
 * onUpdate propagates without cursor jumps.
 */
function DescriptionField({
  value,
  onChange,
  canEmbed,
  uploadFile,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Whether files can be uploaded (task exists) — else paste falls through. */
  canEmbed: boolean;
  uploadFile: (file: File) => Promise<{ url: string; isImage: boolean } | null>;
  placeholder: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      DescriptionImage,
    ],
    content: descriptionToHtml(value),
    editorProps: {
      attributes: {
        class:
          "min-h-[280px] outline-none text-[15px] leading-relaxed text-foreground [&_img]:my-2 [&_img]:max-h-80 [&_img]:rounded-lg [&_img]:border [&_img]:border-border [&_p]:mb-2 [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground/50 [&_p.is-editor-empty:first-child]:before:[content:attr(data-placeholder)]",
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.isEmpty ? "" : editor.getHTML());
    },
  });

  // Upload each pasted/dropped image and drop it into the doc as an inline
  // image node (files → a link). Handled on the wrapper with fresh closures —
  // ProseMirror doesn't insert bare image files itself, so this owns them.
  const insertFiles = async (files: File[]) => {
    if (!editor) return;
    for (const file of files) {
      const res = await uploadFile(file);
      if (!res) continue;
      editor
        .chain()
        .focus()
        .insertContent(
          res.isImage
            ? { type: "image", attrs: { src: res.url, alt: file.name } }
            : `<a href="${res.url}" target="_blank" rel="noreferrer">${file.name}</a> `,
        )
        .run();
    }
  };

  return (
    <EditorContent
      editor={editor}
      className="w-full cursor-text"
      onClick={() => editor?.chain().focus().run()}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files);
        if (files.length > 0 && canEmbed && editor) {
          e.preventDefault();
          void insertFiles(files);
        }
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0 && canEmbed && editor) {
          e.preventDefault();
          void insertFiles(files);
        }
      }}
    />
  );
}

/**
 * The task's attachments: image thumbnails (click for a lightbox with
 * keyboard prev/next) plus a download list for other files, and an upload
 * button. Comment-scoped attachments render inside their comment instead.
 */
function AttachmentsCard({ itemId }: { itemId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const { data: attachments } = useTaskBoardAttachments(itemId);
  const actions = useTaskBoardCommentActions(itemId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const taskLevel = (attachments ?? []).filter((a) => !a.commentId);
  const images = taskLevel.filter((a) => a.mimeType.startsWith("image/"));
  const files = taskLevel.filter((a) => !a.mimeType.startsWith("image/"));

  const upload = async (fileList: FileList | null) => {
    setUploadError(null);
    for (const file of Array.from(fileList ?? [])) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploadError(
          t("taskBoard.taskDialog.attachmentTooLarge", { name: file.name }),
        );
        continue;
      }
      await actions.addAttachment
        .mutateAsync({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          dataBase64: await fileToBase64(file),
        })
        .catch(() => {
          setUploadError(
            t("taskBoard.taskDialog.attachmentUploadFailed", {
              name: file.name,
            }),
          );
        });
    }
  };

  return (
    <div className="flex flex-col gap-2 pb-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t("taskBoard.taskDialog.attachmentsLabel")}
          {taskLevel.length > 0 ? ` (${taskLevel.length})` : ""}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="ml-auto flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          disabled={actions.addAttachment.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          {actions.addAttachment.isPending ? (
            <Loading02 size={13} className="animate-spin" />
          ) : (
            <Plus size={13} />
          )}
          {t("taskBoard.taskDialog.attachButton")}
        </button>
      </div>

      {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((a, index) => (
            <div key={a.id} className="group relative">
              <button
                type="button"
                onClick={() => setLightboxIndex(index)}
                className="block overflow-hidden rounded-lg border border-border"
              >
                <img
                  src={taskBoardAttachmentUrl(org.slug, a.id)}
                  alt={a.filename}
                  loading="lazy"
                  className="size-16 object-cover"
                />
              </button>
              <button
                type="button"
                aria-label={t(
                  "taskBoard.taskDialog.deleteAttachmentAriaLabel",
                  {
                    name: a.filename,
                  },
                )}
                onClick={() => actions.removeAttachment.mutate(a.id)}
                className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded-md bg-background/90 text-muted-foreground hover:text-destructive group-hover:flex"
              >
                <Trash03 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {files.map((a) => (
        <div key={a.id} className="group flex items-center gap-2">
          <File02 size={14} className="shrink-0 text-muted-foreground" />
          <a
            href={taskBoardAttachmentUrl(org.slug, a.id)}
            download={a.filename}
            className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
          >
            {a.filename}
          </a>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatBytes(a.size)}
          </span>
          <button
            type="button"
            aria-label={t("taskBoard.taskDialog.deleteAttachmentAriaLabel", {
              name: a.filename,
            })}
            onClick={() => actions.removeAttachment.mutate(a.id)}
            className="hidden text-muted-foreground hover:text-destructive group-hover:block"
          >
            <Trash03 size={13} />
          </button>
        </div>
      ))}

      {lightboxIndex !== null && images[lightboxIndex] && (
        <AttachmentLightbox
          images={images}
          index={lightboxIndex}
          onNavigate={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

/** Full-size image viewer with keyboard prev/next inside a nested dialog. */
function AttachmentLightbox({
  images,
  index,
  onNavigate,
  onClose,
}: {
  images: TaskBoardAttachment[];
  index: number;
  onNavigate: (next: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const image = images[index]!;
  const prev = () => onNavigate((index - 1 + images.length) % images.length);
  const next = () => onNavigate((index + 1) % images.length);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[92vh] max-w-[92vw] overflow-hidden border-0 bg-transparent p-0 shadow-none sm:max-w-[92vw]"
        closeButtonClassName="hidden"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") prev();
          if (e.key === "ArrowRight") next();
        }}
      >
        <DialogTitle className="sr-only">{image.filename}</DialogTitle>
        <div className="flex items-center justify-center gap-2">
          {images.length > 1 && (
            <Button
              variant="secondary"
              size="icon"
              aria-label={t("taskBoard.taskDialog.lightboxPrevAriaLabel")}
              onClick={prev}
            >
              <ArrowLeft size={16} />
            </Button>
          )}
          <img
            src={taskBoardAttachmentUrl(org.slug, image.id)}
            alt={image.filename}
            className="max-h-[85vh] max-w-[80vw] rounded-xl object-contain"
          />
          {images.length > 1 && (
            <Button
              variant="secondary"
              size="icon"
              aria-label={t("taskBoard.taskDialog.lightboxNextAriaLabel")}
              onClick={next}
            >
              <ArrowRight size={16} />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One comment row: author, time, body, images, reply/edit/delete actions. */
function CommentRow({
  comment,
  author,
  isOwn,
  onReply,
  onDelete,
  onEdit,
}: {
  comment: TaskBoardComment;
  author?: Member;
  isOwn: boolean;
  onReply?: () => void;
  onDelete: () => void;
  onEdit: (body: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const images = comment.attachments.filter((a) =>
    a.mimeType.startsWith("image/"),
  );
  const files = comment.attachments.filter(
    (a) => !a.mimeType.startsWith("image/"),
  );

  return (
    <div className="group flex gap-2.5">
      <Avatar
        url={author?.user?.image ?? undefined}
        fallback={getInitials(author?.user?.name)}
        shape="circle"
        size="xs"
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {author?.user?.name ?? t("taskBoard.taskDialog.someoneLabel")}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatTimeAgo(new Date(comment.createdAt))}
          </span>
          <span className="ml-auto hidden items-center gap-1 group-hover:flex">
            {onReply && (
              <button
                type="button"
                onClick={onReply}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {t("taskBoard.taskDialog.replyButton")}
              </button>
            )}
            {isOwn && (
              <>
                <button
                  type="button"
                  aria-label={t("taskBoard.taskDialog.editCommentAriaLabel")}
                  onClick={() => {
                    setDraft(comment.body);
                    setEditing(true);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Edit05 size={13} />
                </button>
                <button
                  type="button"
                  aria-label={t("taskBoard.taskDialog.deleteCommentAriaLabel")}
                  onClick={onDelete}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash03 size={13} />
                </button>
              </>
            )}
          </span>
        </div>
        {editing ? (
          <div className="mt-1 flex flex-col gap-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none"
            />
            <div className="flex gap-1.5 self-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
              >
                {t("taskBoard.taskDialog.cancelButton")}
              </Button>
              <Button
                size="sm"
                disabled={!draft.trim()}
                onClick={() => {
                  onEdit(draft.trim());
                  setEditing(false);
                }}
              >
                {t("taskBoard.taskDialog.saveButton")}
              </Button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">
            {comment.body}
          </p>
        )}
        {images.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {images.map((a) => (
              <a
                key={a.id}
                href={taskBoardAttachmentUrl(org.slug, a.id)}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-lg border border-border"
              >
                <img
                  src={taskBoardAttachmentUrl(org.slug, a.id)}
                  alt={a.filename}
                  loading="lazy"
                  className="size-20 object-cover"
                />
              </a>
            ))}
          </div>
        )}
        {files.map((a) => (
          <a
            key={a.id}
            href={taskBoardAttachmentUrl(org.slug, a.id)}
            download={a.filename}
            className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <File02 size={13} />
            <span className="truncate">{a.filename}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * The task's comment stream: top-level comments with one level of nested
 * replies, and a composer (text + optional image/file attachments) at the
 * bottom. Reply targets are chosen inline via each comment's Reply action.
 */
/**
 * Unified Activity feed (Linear-style): the task's linked agent sessions
 * (threads), pull requests and comments interleaved in chronological order,
 * with a comment composer at the bottom. Threads and PRs are clickable cards;
 * comments render inline with one level of replies.
 *
 * ponytail: a full status-change timeline ("moved from In Progress to In
 * Review") would need a task audit log we don't keep yet — out of scope here;
 * this feed unifies the things we do track.
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
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id ?? null;
  const { data: comments } = useTaskBoardComments(item.id);
  const { data: activity } = useTaskBoardActivity(item.id);
  const actions = useTaskBoardCommentActions(item.id);

  const memberByUserId = new Map(members.map((m) => [m.userId, m]));
  const repliesByParent = new Map<string, TaskBoardComment[]>();
  for (const c of comments ?? []) {
    if (!c.parentId) continue;
    const list = repliesByParent.get(c.parentId);
    if (list) list.push(c);
    else repliesByParent.set(c.parentId, [c]);
  }

  const sendComment = (body: string, files: File[], parentId?: string | null) =>
    Promise.all(
      files.map(async (file) => ({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: await fileToBase64(file),
      })),
    ).then((attachments) =>
      actions.create
        .mutateAsync({
          body,
          parentId: parentId ?? null,
          attachments: attachments.length > 0 ? attachments : undefined,
        })
        .then(() => undefined),
    );

  // Merge the change timeline, agent sessions and comments into one
  // chronological feed (oldest first, like Linear). Consecutive timeline events
  // render as a connected run; everything else is a card. (PRs live in the
  // Links panel, not the timeline.)
  type Ev =
    | { kind: "activity"; at: number; activity: TaskBoardActivity }
    | { kind: "thread"; at: number; thread: TaskBoardItemThread }
    | { kind: "comment"; at: number; comment: TaskBoardComment };
  const events: Ev[] = [
    ...(activity ?? []).map(
      (a): Ev => ({
        kind: "activity",
        at: new Date(a.createdAt).getTime(),
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
    ...(comments ?? [])
      .filter((c) => !c.parentId)
      .map(
        (comment): Ev => ({
          kind: "comment",
          at: new Date(comment.createdAt).getTime(),
          comment,
        }),
      ),
  ].sort((a, b) => a.at - b.at);

  // Group consecutive timeline events so their icons connect with a rail.
  type CardEv = Extract<Ev, { kind: "thread" | "comment" }>;
  const blocks: (
    | { type: "timeline"; items: TaskBoardActivity[] }
    | { type: "card"; ev: CardEv }
  )[] = [];
  for (const ev of events) {
    if (ev.kind === "activity") {
      const last = blocks[blocks.length - 1];
      if (last?.type === "timeline") last.items.push(ev.activity);
      else blocks.push({ type: "timeline", items: [ev.activity] });
    } else {
      blocks.push({ type: "card", ev });
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-6">
      <span className="text-xs font-medium text-muted-foreground">
        {t("taskBoard.taskDialog.activityLabel")}
      </span>

      {blocks.map((block, i) => {
        if (block.type === "timeline") {
          return (
            <TimelineBlock
              key={`tl-${i}`}
              items={block.items}
              memberByUserId={memberByUserId}
            />
          );
        }
        const ev = block.ev;
        if (ev.kind === "thread") {
          return (
            <ThreadActivityItem
              key={`thread-${ev.thread.threadId}`}
              thread={ev.thread}
              startedBy={startedBy}
              onOpen={onOpenThread}
            />
          );
        }
        const comment = ev.comment;
        return (
          <CommentCard
            key={`comment-${comment.id}`}
            comment={comment}
            replies={repliesByParent.get(comment.id) ?? []}
            memberByUserId={memberByUserId}
            currentUserId={currentUserId}
            onReply={(body, files) => sendComment(body, files, comment.id)}
            onDelete={(id) => actions.remove.mutate(id)}
            onEdit={(id, body) => actions.update.mutate({ id, body })}
          />
        );
      })}

      <Composer
        placeholder={t("taskBoard.taskDialog.commentPlaceholder")}
        pending={actions.create.isPending}
        onSend={(body, files) => sendComment(body, files, null)}
      />
    </div>
  );
}

/** Human icon + text for one timeline event. */
function describeActivity(
  a: TaskBoardActivity,
  t: ReturnType<typeof useT>,
  memberByUserId: Map<string, Member>,
): { icon: ReactNode; text: string } {
  const memberName = (id: unknown) =>
    (typeof id === "string" && memberByUserId.get(id)?.user?.name) ||
    t("taskBoard.taskDialog.someoneLabel");
  const statusLabel = (s: unknown) => {
    const cfg =
      typeof s === "string"
        ? STATUS_CONFIG[s as keyof typeof STATUS_CONFIG]
        : undefined;
    return cfg ? t(cfg.labelKey) : String(s ?? "");
  };
  const d = a.data;
  switch (a.kind) {
    case "created":
      return {
        icon: <Plus size={12} />,
        text: t("taskBoard.taskDialog.activityCreated"),
      };
    case "status_changed": {
      const Icon =
        (typeof d.to === "string" &&
          STATUS_CONFIG[d.to as keyof typeof STATUS_CONFIG]?.icon) ||
        Circle;
      return {
        icon: <Icon size={12} />,
        text: d.from
          ? t("taskBoard.taskDialog.activityMovedFromTo", {
              from: statusLabel(d.from),
              to: statusLabel(d.to),
            })
          : t("taskBoard.taskDialog.activityMovedTo", {
              to: statusLabel(d.to),
            }),
      };
    }
    case "assignee_changed":
      if (d.to === SUPER_AGENT_ASSIGNEE_ID)
        return {
          icon: <SuperAgentIcon size={13} />,
          text: t("taskBoard.taskDialog.activityDelegated"),
        };
      if (d.to == null)
        return {
          icon: <UserPlus01 size={12} />,
          text: t("taskBoard.taskDialog.activityUnassigned"),
        };
      return {
        icon: <UserPlus01 size={12} />,
        text: t("taskBoard.taskDialog.activityAssigned", {
          name: memberName(d.to),
        }),
      };
    case "sprint_changed":
      return {
        icon: <RefreshCw01 size={12} />,
        text:
          typeof d.to === "string"
            ? t("taskBoard.taskDialog.activitySprintMoved", {
                name: formatSprintRange(d.to),
              })
            : t("taskBoard.taskDialog.activitySprintRemoved"),
      };
    default: {
      const _exhaustive: never = a.kind;
      return { icon: <Circle size={12} />, text: String(_exhaustive) };
    }
  }
}

/** A run of consecutive timeline events, icons joined by a vertical rail. */
function TimelineBlock({
  items,
  memberByUserId,
}: {
  items: TaskBoardActivity[];
  memberByUserId: Map<string, Member>;
}) {
  const t = useT();
  const actorName = (actorId: string | null) => {
    if (!actorId) return t("taskBoard.taskDialog.someoneLabel");
    if (actorId === "system" || actorId === SUPER_AGENT_ASSIGNEE_ID)
      return t("taskBoard.taskDialog.superAgentLabel");
    return (
      memberByUserId.get(actorId)?.user?.name ??
      t("taskBoard.taskDialog.someoneLabel")
    );
  };
  const actorAvatar = (actorId: string | null) => {
    if (
      !actorId ||
      actorId === "system" ||
      actorId === SUPER_AGENT_ASSIGNEE_ID
    ) {
      return (
        <span className="z-10 flex size-4 shrink-0 items-center justify-center">
          <SuperAgentIcon size={16} />
        </span>
      );
    }
    const member = memberByUserId.get(actorId);
    return (
      <span className="z-10 shrink-0">
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
    <div className="relative flex flex-col gap-5">
      {items.length > 1 && (
        <span
          aria-hidden
          className="absolute left-[8px] top-3 bottom-3 w-px bg-border"
        />
      )}
      {items.map((a) => {
        const { text } = describeActivity(a, t, memberByUserId);
        return (
          <div key={a.id} className="relative flex items-center gap-2.5">
            {actorAvatar(a.actorId)}
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {actorName(a.actorId)}
              </span>{" "}
              {text}
              <span className="text-muted-foreground/60">
                {" · "}
                {formatTimeAgo(new Date(a.createdAt))}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A top-level comment card with its replies and an inline reply composer. */
function CommentCard({
  comment,
  replies,
  memberByUserId,
  currentUserId,
  onReply,
  onDelete,
  onEdit,
}: {
  comment: TaskBoardComment;
  replies: TaskBoardComment[];
  memberByUserId: Map<string, Member>;
  currentUserId: string | null;
  onReply: (body: string, files: File[]) => Promise<void>;
  onDelete: (id: string) => void;
  onEdit: (id: string, body: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col overflow-hidden rounded-xl bg-card card-shadow">
      <div className="flex flex-col gap-4 p-3.5">
        <CommentRow
          comment={comment}
          author={memberByUserId.get(comment.createdBy)}
          isOwn={comment.createdBy === currentUserId}
          onDelete={() => onDelete(comment.id)}
          onEdit={(body) => onEdit(comment.id, body)}
        />
        {replies.map((reply) => (
          <div key={reply.id} className="border-l border-border pl-3">
            <CommentRow
              comment={reply}
              author={memberByUserId.get(reply.createdBy)}
              isOwn={reply.createdBy === currentUserId}
              onDelete={() => onDelete(reply.id)}
              onEdit={(body) => onEdit(reply.id, body)}
            />
          </div>
        ))}
      </div>
      <div className="border-t border-border px-3 py-2">
        <Composer
          placeholder={t("taskBoard.taskDialog.leaveReplyPlaceholder")}
          slim
          onSend={onReply}
        />
      </div>
    </div>
  );
}

/**
 * Comment/reply composer — a growing text row with attach + send. Reused for
 * the bottom "Leave a comment" and each card's inline "Leave a reply". `slim`
 * drops the border (it sits inside a card footer).
 */
function Composer({
  placeholder,
  onSend,
  pending,
  slim,
}: {
  placeholder: string;
  onSend: (body: string, files: File[]) => Promise<void>;
  pending?: boolean;
  slim?: boolean;
}) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = sending || !!pending;

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setError(null);
    setSending(true);
    try {
      await onSend(body, files);
      setDraft("");
      setFiles([]);
    } catch {
      setError(t("taskBoard.taskDialog.commentSendFailed"));
    } finally {
      setSending(false);
    }
  };

  const addFiles = (fileList: FileList | null) => {
    setError(null);
    const incoming = Array.from(fileList ?? []);
    const oversize = incoming.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (oversize) {
      setError(
        t("taskBoard.taskDialog.attachmentTooLarge", { name: oversize.name }),
      );
    }
    setFiles((prev) => [
      ...prev,
      ...incoming.filter((f) => f.size <= MAX_UPLOAD_BYTES),
    ]);
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        !slim && "rounded-xl border border-border p-3",
      )}
    >
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((file, i) => (
            <span
              key={`${file.name}-${i}`}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground"
            >
              <File02 size={12} />
              <span className="max-w-40 truncate">{file.name}</span>
              <button
                type="button"
                aria-label={t(
                  "taskBoard.taskDialog.removePendingFileAriaLabel",
                  {
                    name: file.name,
                  },
                )}
                onClick={() =>
                  setFiles((prev) => prev.filter((_, x) => x !== i))
                }
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="min-h-8 w-full flex-1 resize-none self-center bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          aria-label={t("taskBoard.taskDialog.attachToCommentAriaLabel")}
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Attachment01 size={16} />
        </button>
        <button
          type="button"
          aria-label={t("taskBoard.taskDialog.sendCommentAriaLabel")}
          disabled={!draft.trim() || busy}
          onClick={() => void submit()}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-accent disabled:opacity-40"
        >
          {busy ? (
            <Loading02 size={14} className="animate-spin" />
          ) : (
            <ArrowUp size={14} />
          )}
        </button>
      </div>
    </div>
  );
}
