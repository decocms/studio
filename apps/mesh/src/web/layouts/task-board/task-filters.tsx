/**
 * Task board filters — assignee, priority and due date. Filtering is pure
 * (`taskMatchesFilters`) so both the board and list views share it, and the
 * bar is presentational: it owns no state beyond the open/closed popovers.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { Avatar } from "@deco/ui/components/avatar.tsx";
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
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Calendar,
  ChevronDown,
  Flag01,
  FilterLines,
  User01,
} from "@untitledui/icons";
import { SuperAgentIcon } from "@/web/components/super-agent-icon";
import { getInitials } from "@/web/lib/get-initials";
import {
  PRIORITIES,
  PRIORITY_CONFIG,
  SUPER_AGENT_ASSIGNEE_ID,
  type Member,
  type TaskBoardItem,
  type TaskBoardItemPriority,
} from "./config";

/** Sentinel assignee filter matching tasks with no assignee. */
export const UNASSIGNED_FILTER = "__unassigned__";

export type DueFilter = "overdue" | "today" | "week" | "none";

export type TaskFilters = {
  /** userId | SUPER_AGENT_ASSIGNEE_ID | UNASSIGNED_FILTER | null (anyone) */
  assignee: string | null;
  priority: TaskBoardItemPriority | null;
  due: DueFilter | null;
};

export const EMPTY_FILTERS: TaskFilters = {
  assignee: null,
  priority: null,
  due: null,
};

export function hasActiveFilters(f: TaskFilters): boolean {
  return f.assignee !== null || f.priority !== null || f.due !== null;
}

const DAY_MS = 86_400_000;

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function taskMatchesFilters(
  item: TaskBoardItem,
  f: TaskFilters,
): boolean {
  if (f.assignee !== null) {
    if (f.assignee === UNASSIGNED_FILTER) {
      if (item.assigneeId !== null) return false;
    } else if (item.assigneeId !== f.assignee) {
      return false;
    }
  }
  if (f.priority !== null && item.priority !== f.priority) return false;
  if (f.due !== null) {
    if (f.due === "none") {
      if (item.dueDate) return false;
    } else {
      if (!item.dueDate) return false;
      const t = new Date(item.dueDate).getTime();
      const now = Date.now();
      if (f.due === "overdue" && t >= now) return false;
      if (f.due === "today" && !isSameDay(t, now)) return false;
      if (f.due === "week" && t > now + 7 * DAY_MS) return false;
    }
  }
  return true;
}

const DUE_OPTIONS: { value: DueFilter; label: string }[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Due this week" },
  { value: "none", label: "No due date" },
];

/** Shared trigger styling — a compact chip that fills in when a value is set. */
function chipClass(active: boolean): string {
  return cn(
    "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium outline-none transition-colors",
    active
      ? "border-transparent bg-accent text-foreground"
      : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground",
  );
}

function AssigneeFilter({
  value,
  members,
  onChange,
}: {
  value: string | null;
  members: Member[];
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  let glyph: ReactNode = <User01 size={14} className="shrink-0" />;
  let label = "Assignee";
  if (value === UNASSIGNED_FILTER) {
    label = "Unassigned";
  } else if (value === SUPER_AGENT_ASSIGNEE_ID) {
    glyph = <SuperAgentIcon size={14} />;
    label = "Super Agent";
  } else if (value) {
    const member = members.find((m) => m.userId === value);
    glyph = (
      <Avatar
        url={member?.user?.image ?? undefined}
        fallback={getInitials(member?.user?.name)}
        shape="circle"
        size="2xs"
      />
    );
    label = member?.user?.name ?? "Member";
  }

  const select = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  const triggerClass = chipClass(value !== null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClass}>
          {glyph}
          <span className="max-w-[10rem] truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Filter by assignee…" className="h-9" />
          <CommandList>
            <CommandEmpty>No members found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="Anyone" onSelect={() => select(null)}>
                Anyone
              </CommandItem>
              <CommandItem
                value="Unassigned"
                onSelect={() => select(UNASSIGNED_FILTER)}
                className="gap-2"
              >
                <User01 size={16} className="text-muted-foreground" />
                Unassigned
              </CommandItem>
              <CommandItem
                value="Super Agent"
                onSelect={() => select(SUPER_AGENT_ASSIGNEE_ID)}
                className="gap-2"
              >
                <SuperAgentIcon size={16} />
                Super Agent
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Members">
              {members.map((m) => (
                <CommandItem
                  key={m.userId}
                  value={m.user?.name ?? m.userId}
                  onSelect={() => select(m.userId)}
                  className="gap-2"
                >
                  <Avatar
                    url={m.user?.image ?? undefined}
                    fallback={getInitials(m.user?.name)}
                    shape="circle"
                    size="2xs"
                  />
                  <span className="truncate">{m.user?.name ?? m.userId}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PriorityFilter({
  value,
  onChange,
}: {
  value: TaskBoardItemPriority | null;
  onChange: (next: TaskBoardItemPriority | null) => void;
}) {
  const triggerClass = chipClass(value !== null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClass}>
          {value ? (
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                PRIORITY_CONFIG[value].dotClassName,
              )}
            />
          ) : (
            <Flag01 size={14} className="shrink-0" />
          )}
          {value ? PRIORITY_CONFIG[value].label : "Priority"}
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          Any priority
        </DropdownMenuItem>
        {PRIORITIES.map((p) => (
          <DropdownMenuItem
            key={p}
            onSelect={() => onChange(p)}
            className="gap-2"
          >
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
  );
}

function DueDateFilter({
  value,
  onChange,
}: {
  value: DueFilter | null;
  onChange: (next: DueFilter | null) => void;
}) {
  const label = DUE_OPTIONS.find((o) => o.value === value)?.label;
  const triggerClass = chipClass(value !== null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClass}>
          <Calendar size={14} className="shrink-0" />
          {label ?? "Due date"}
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem onSelect={() => onChange(null)} className="gap-2">
          <Calendar size={16} className="text-muted-foreground" />
          Any time
        </DropdownMenuItem>
        {DUE_OPTIONS.map((o) => {
          const danger = o.value === "overdue";
          return (
            <DropdownMenuItem
              key={o.value}
              onSelect={() => onChange(o.value)}
              className={cn("gap-2", danger && "text-destructive")}
            >
              <Calendar
                size={16}
                className={cn(
                  "shrink-0",
                  danger ? "text-destructive" : "text-muted-foreground",
                )}
              />
              {o.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TaskFiltersBar({
  filters,
  members,
  onChange,
}: {
  filters: TaskFilters;
  members: Member[];
  onChange: (next: TaskFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterLines
        size={16}
        className="mr-0.5 shrink-0 text-muted-foreground"
      />
      <AssigneeFilter
        value={filters.assignee}
        members={members}
        onChange={(assignee) => onChange({ ...filters, assignee })}
      />
      <PriorityFilter
        value={filters.priority}
        onChange={(priority) => onChange({ ...filters, priority })}
      />
      <DueDateFilter
        value={filters.due}
        onChange={(due) => onChange({ ...filters, due })}
      />
      {hasActiveFilters(filters) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="ml-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}
