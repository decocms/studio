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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import { Calendar as DayPickerCalendar } from "@deco/ui/components/calendar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  AlertCircle,
  AlertSquare,
  Calendar,
  CheckCircle,
  ChevronRight,
  DotsHorizontal,
  HelpCircle,
  Loading02,
  Plus,
  Trash03,
  User01,
  UserPlus01,
  X,
} from "@untitledui/icons";
import { SuperAgentIcon } from "@/web/components/super-agent-icon";
import { useMembers } from "@/web/hooks/use-members";
import { getInitials } from "@/web/lib/get-initials";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  primaryThread,
  PRIORITIES,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  SUPER_AGENT_ASSIGNEE_ID,
  type Member,
  type TaskBoardItem,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type TaskBoardItemThread,
} from "./config";

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
  "inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:border-transparent";

const THREAD_STATUS: Record<
  NonNullable<TaskBoardItemThread["status"]>,
  { label: string; className: string; icon: typeof AlertSquare; spin?: boolean }
> = {
  failed: { label: "Error", className: "text-red-600", icon: AlertSquare },
  requires_action: {
    label: "Needs input",
    className: "text-amber-600",
    icon: HelpCircle,
  },
  in_progress: {
    label: "Running",
    className: "text-blue-600",
    icon: Loading02,
    spin: true,
  },
  completed: {
    label: "Completed",
    className: "text-green-600",
    icon: CheckCircle,
  },
  expired: {
    label: "Expired",
    className: "text-muted-foreground",
    icon: AlertCircle,
  },
};

export function TaskBoardItemDialog({
  open,
  onClose,
  item,
  defaultStatus,
  onSubmit,
  onDelete,
  onOpenThread,
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
  isSaving?: boolean;
}) {
  const { data } = useMembers();
  const members = (data?.data?.members ?? []) as Member[];

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
  const thread = item ? primaryThread(item) : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[85vh] sm:max-h-[640px] sm:max-w-[850px]"
        closeButtonClassName="hidden"
      >
        <DialogTitle className="sr-only">
          {item ? "Edit task" : "New task"}
        </DialogTitle>

        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className="absolute right-2.5 top-2.5 z-10 flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row sm:overflow-hidden">
          {/* Editor pane — content-height on mobile so it doesn't leave a big
              gap above the properties; fills the column on desktop. */}
          <div className="flex min-w-0 flex-col gap-6 p-6 sm:flex-1 sm:overflow-y-auto sm:p-8">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              autoFocus
              className="w-full border-0 bg-transparent text-xl font-medium text-foreground outline-none placeholder:text-foreground/30"
            />

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe a task for an agent..."
              className="min-h-[96px] w-full flex-1 resize-none border-0 bg-transparent text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50 sm:min-h-[120px]"
            />

            {thread && (
              <ActivityCard
                thread={thread}
                startedBy={assignedBy ?? assignee}
                onOpen={onOpenThread}
              />
            )}
          </div>

          {/* Properties pane — wrapping chips under the editor on mobile, a
              stacked sidebar on desktop. */}
          <div className="flex w-full shrink-0 flex-col gap-4 border-t border-border p-6 sm:w-[220px] sm:border-t-0 sm:border-l sm:px-6 sm:py-10">
            <span className="hidden px-3 text-sm text-muted-foreground sm:block">
              Properties
            </span>

            <div className="flex flex-wrap gap-2 sm:flex-col">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={PROPERTY_BUTTON}>
                    <StatusIcon
                      size={16}
                      className={STATUS_CONFIG[status].iconClassName}
                    />
                    {STATUS_CONFIG[status].label}
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
                        {STATUS_CONFIG[s].label}
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
                        Set priority
                      </>
                    ) : (
                      <>
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            PRIORITY_CONFIG[priority].dotClassName,
                          )}
                        />
                        {PRIORITY_CONFIG[priority].label}
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
                      {PRIORITY_CONFIG[p].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <div className="flex flex-col">
                <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
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
                          <Avatar
                            url={assignedBy.user?.image ?? undefined}
                            fallback={getInitials(assignedBy.user?.name)}
                            shape="circle"
                            size="2xs"
                          />
                          <span className="truncate">
                            {assignedBy.user?.name ?? "Super Agent"}
                          </span>
                        </>
                      ) : isSuperAgent ? (
                        <>
                          <SuperAgentIcon size={16} />
                          Super Agent
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
                            {assignee.user?.name ?? "Unassigned"}
                          </span>
                        </>
                      ) : (
                        <>
                          <UserPlus01
                            size={16}
                            className="text-muted-foreground"
                          />
                          Assign
                        </>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-56 p-0">
                    <Command>
                      <CommandInput placeholder="Assign to…" className="h-9" />
                      <CommandList>
                        <CommandEmpty>No members found.</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            value="Super Agent"
                            onSelect={() => {
                              setAssigneeId(SUPER_AGENT_ASSIGNEE_ID);
                              setAssigneeOpen(false);
                            }}
                            className="gap-2"
                          >
                            <SuperAgentIcon size={16} />
                            <span className="truncate">Super Agent</span>
                          </CommandItem>
                          <CommandItem
                            value="Unassigned"
                            onSelect={() => {
                              setAssigneeId(null);
                              setAssigneeOpen(false);
                            }}
                            className="gap-2"
                          >
                            <User01
                              size={16}
                              className="text-muted-foreground"
                            />
                            <span className="truncate">Unassigned</span>
                          </CommandItem>
                        </CommandGroup>
                        <CommandGroup heading="Members">
                          {members.map((m) => (
                            <CommandItem
                              key={m.userId}
                              value={m.user?.name ?? m.userId}
                              onSelect={() => {
                                setAssigneeId(m.userId);
                                setAssigneeOpen(false);
                              }}
                              className="gap-2"
                            >
                              <Avatar
                                url={m.user?.image ?? undefined}
                                fallback={getInitials(m.user?.name)}
                                shape="circle"
                                size="2xs"
                              />
                              <span className="truncate">
                                {m.user?.name ?? m.userId}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>

                {/* Delegation: the Super Agent doing the work, nested under
                    the human who handed it off. */}
                {isSuperAgent && assignedBy && (
                  <div className="relative flex items-center pl-5">
                    {/* Elbow drops from the center of the assigner's avatar
                        (px-3 padding + half of the w-4 "2xs" avatar = 20px). */}
                    <span className="absolute left-5 top-0 h-1/2 w-2.5 rounded-bl-md border-b border-l border-border" />
                    <span
                      className={cn(PROPERTY_BUTTON, "pointer-events-none")}
                    >
                      <SuperAgentIcon size={16} />
                      Super Agent
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
                    {dueDate ? DUE_DATE_FMT.format(dueDate) : "Due date"}
                    {dueDate && (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Clear due date"
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
              aria-label="Delete task"
              className="size-10 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash03 size={16} />
            </Button>
          ) : (
            <span />
          )}

          <Button
            size="sm"
            disabled={!title.trim() || isSaving}
            onClick={submit}
          >
            <Plus size={16} />
            {item ? "Save" : "Create task"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The linked run's activity: a header ("Super Agent started by X") and a status
 * row (Error / Running / …). Clicking opens the run's thread.
 */
function ActivityCard({
  thread,
  startedBy,
  onOpen,
}: {
  thread: TaskBoardItemThread;
  startedBy?: Member;
  onOpen?: (thread: TaskBoardItemThread) => void;
}) {
  const state = thread.status ? THREAD_STATUS[thread.status] : null;
  const message = thread.lastMessage ?? thread.title;

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <SuperAgentIcon size={16} />
        <span className="text-sm text-foreground">Super Agent</span>
        {startedBy && (
          <>
            <span className="text-sm text-muted-foreground/50">started by</span>
            <Avatar
              url={startedBy.user?.image ?? undefined}
              fallback={getInitials(startedBy.user?.name)}
              shape="circle"
              size="2xs"
            />
            <span className="truncate text-sm text-foreground">
              {startedBy.user?.name ?? "someone"}
            </span>
          </>
        )}
      </div>

      {state && (
        <button
          type="button"
          disabled={!onOpen}
          onClick={() => onOpen?.(thread)}
          className="flex items-center gap-2 border-t border-border px-4 py-2 text-left transition-colors enabled:hover:bg-muted disabled:cursor-default"
        >
          <span className={cn("flex items-center gap-1.5", state.className)}>
            <state.icon
              size={16}
              className={cn(state.spin && "animate-spin")}
            />
            <span className="text-sm">{state.label}</span>
          </span>
          {message && (
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {message}
            </span>
          )}
          {onOpen && (
            <ChevronRight
              size={16}
              className="ml-auto shrink-0 text-muted-foreground"
            />
          )}
        </button>
      )}
    </div>
  );
}
