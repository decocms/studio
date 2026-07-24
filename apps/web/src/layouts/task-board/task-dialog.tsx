import { useState } from "react";
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
  PRIORITIES,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  SUPER_AGENT_ASSIGNEE_ID,
  type Member,
  type TaskBoardItem,
  type TaskBoardItemPr,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type TaskBoardItemThread,
} from "./config";
import { useTaskBoardItemPrs } from "@/hooks/use-task-board-item-prs";
import { GitHubIcon } from "@/components/icons/github-icon";
import { AssigneePickerContent } from "./assignee-picker";

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
  const [dueOpen, setDueOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);

  const reset = () => {
    setTitle(item?.title ?? "");
    setDescription(item?.description ?? "");
    setStatus(item?.status ?? defaultStatus ?? "triage");
    setPriority(item?.priority ?? "medium");
    setAssigneeId(item?.assigneeId ?? null);
    setDueDate(parseIsoDate(item?.dueDate));
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
      status,
      priority,
      assigneeId,
      dueDate: dueDate ? toEndOfDayIso(dueDate) : null,
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
        className="flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[85vh] sm:max-h-[640px] sm:max-w-[850px]"
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
          <div className="flex min-w-0 flex-col gap-6 p-6 sm:flex-1 sm:overflow-y-auto sm:p-8">
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

            <div className="group relative flex flex-1 flex-col">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("taskBoard.taskDialog.descriptionPlaceholder")}
                className="min-h-[96px] w-full flex-1 resize-none border-0 bg-transparent text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50 sm:min-h-[120px]"
              />
              {description && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t(
                    "taskBoard.taskDialog.copyDescriptionAriaLabel",
                  )}
                  className="absolute right-0 top-0 size-7 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  onClick={() => handleCopy(description)}
                >
                  {copied ? <Check size={14} /> : <Copy01 size={14} />}
                </Button>
              )}
            </div>

            {item?.id && (
              <LinksSection
                item={item}
                description={description}
                onOpenThread={onOpenThread}
              />
            )}

            {item && item.threads.length > 0 && (
              <div className="flex flex-col gap-3">
                {item.threads.map((th) => (
                  <ThreadActivityItem
                    key={th.threadId}
                    thread={th}
                    startedBy={assignedBy ?? assignee}
                    onOpen={onOpenThread}
                  />
                ))}
              </div>
            )}
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
