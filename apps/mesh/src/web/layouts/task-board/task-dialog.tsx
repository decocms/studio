import { useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
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
import { Calendar, ChevronDown, Trash01, User01, X } from "@untitledui/icons";
import { useMembers } from "@/web/hooks/use-members";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  PRIORITIES,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  type TaskBoardItem,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type Member,
} from "./config";

function getInitials(name?: string | null) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

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

export function TaskBoardItemDialog({
  open,
  onClose,
  item,
  onSubmit,
  onDelete,
  isSaving,
}: {
  open: boolean;
  onClose: () => void;
  /** Present in edit mode, prefills the form. */
  item?: TaskBoardItem;
  onSubmit: (input: {
    title: string;
    description: string | null;
    status: TaskBoardItemStatus;
    priority: TaskBoardItemPriority;
    assigneeId: string | null;
    dueDate: string | null;
  }) => void;
  onDelete?: () => void;
  isSaving?: boolean;
}) {
  const { data } = useMembers();
  const members = (data?.data?.members ?? []) as Member[];

  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [status, setStatus] = useState<TaskBoardItemStatus>(
    item?.status ?? "triage",
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

  const reset = () => {
    setTitle(item?.title ?? "");
    setDescription(item?.description ?? "");
    setStatus(item?.status ?? "triage");
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

  const assignee = members.find((m) => m.userId === assigneeId);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:!max-w-[640px]"
      >
        <SheetTitle className="sr-only">
          {item ? "Edit task" : "New task"}
        </SheetTitle>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex flex-col gap-4 border-b border-border px-6 pt-14 pb-5">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              autoFocus
              className="w-full border-0 bg-transparent text-xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/70"
            />

            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    {(() => {
                      const Icon = STATUS_CONFIG[status].icon;
                      return (
                        <Icon
                          size={13}
                          className={STATUS_CONFIG[status].iconClassName}
                        />
                      );
                    })()}
                    {STATUS_CONFIG[status].label}
                    <ChevronDown size={12} className="text-muted-foreground" />
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
                          size={13}
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        PRIORITY_CONFIG[priority].badgeClassName,
                      )}
                    />
                    {PRIORITY_CONFIG[priority].label}
                    <ChevronDown size={12} className="text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  {PRIORITIES.map((p) => (
                    <DropdownMenuItem key={p} onSelect={() => setPriority(p)}>
                      {PRIORITY_CONFIG[p].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    {assignee ? (
                      <Avatar
                        url={assignee.user?.image ?? undefined}
                        fallback={getInitials(assignee.user?.name)}
                        shape="circle"
                        size="2xs"
                      />
                    ) : (
                      <User01 size={13} className="text-muted-foreground" />
                    )}
                    {assignee?.user?.name ?? "Unassigned"}
                    <ChevronDown size={12} className="text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem onSelect={() => setAssigneeId(null)}>
                    Unassigned
                  </DropdownMenuItem>
                  {members.map((m) => (
                    <DropdownMenuItem
                      key={m.userId}
                      onSelect={() => setAssigneeId(m.userId)}
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
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Popover open={dueOpen} onOpenChange={setDueOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Calendar size={13} className="text-muted-foreground" />
                    {dueDate ? DUE_DATE_FMT.format(dueDate) : "Due date"}
                    {dueDate ? (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Clear due date"
                        className="-mr-0.5 ml-0.5 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
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
                    ) : (
                      <ChevronDown
                        size={12}
                        className="text-muted-foreground"
                      />
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

          <div className="flex flex-1 flex-col px-6 py-5">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a description…"
              className="min-h-[320px] w-full flex-1 resize-none border-0 bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-6 py-3">
          {item && onDelete && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete task"
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash01 size={14} />
            </Button>
          )}

          <Button
            size="sm"
            className="ml-auto"
            disabled={!title.trim() || isSaving}
            onClick={submit}
          >
            {item ? "Save" : "Create task"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
