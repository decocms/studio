/**
 * Task board filters — assignee, priority and due date. Filtering is pure
 * (`taskMatchesFilters`) so both the board and list views share it, and the
 * bar is presentational: it owns no state beyond the open/closed popovers.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerTitle,
  DrawerTrigger,
} from "@decocms/ui/components/drawer.tsx";
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Calendar,
  Check,
  ChevronDown,
  Flag01,
  FilterLines,
  SearchSm,
  Tag01,
  User01,
  X,
} from "@untitledui/icons";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import { getInitials } from "@/lib/get-initials";
import {
  PRIORITIES,
  PRIORITY_CONFIG,
  SUPER_AGENT_ASSIGNEE_ID,
  tagDotColor,
  type Member,
  type OrgTag,
  type TaskBoardItem,
  type TaskBoardItemPriority,
} from "./config";

/** Sentinel assignee filter matching tasks with no assignee. */
const UNASSIGNED_FILTER = "__unassigned__";

/** Sentinel repo filter matching tasks with no associated repo. */
const NO_REPO_FILTER = "__no_repo__";

export type DueFilter = "overdue" | "today" | "week" | "none";

export type TaskFilters = {
  /** userId | SUPER_AGENT_ASSIGNEE_ID | UNASSIGNED_FILTER | null (anyone) */
  assignee: string | null;
  priority: TaskBoardItemPriority | null;
  due: DueFilter | null;
  /** Org tag ids — a task matches if it has at least one of these. */
  tags: string[];
  /** `owner/name` | NO_REPO_FILTER | null (any repo) */
  repo: string | null;
  /** Free-text match against title/description, empty string = no filter. */
  search: string;
};

export const EMPTY_FILTERS: TaskFilters = {
  assignee: null,
  priority: null,
  due: null,
  tags: [],
  repo: null,
  search: "",
};

function hasActiveFilters(f: TaskFilters): boolean {
  return (
    f.assignee !== null ||
    f.priority !== null ||
    f.due !== null ||
    f.tags.length > 0 ||
    f.repo !== null ||
    f.search.trim() !== ""
  );
}

function activeFilterCount(f: TaskFilters): number {
  return (
    (f.assignee !== null ? 1 : 0) +
    (f.priority !== null ? 1 : 0) +
    (f.due !== null ? 1 : 0) +
    (f.tags.length > 0 ? 1 : 0) +
    (f.repo !== null ? 1 : 0) +
    (f.search.trim() !== "" ? 1 : 0)
  );
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
  const search = f.search.trim().toLowerCase();
  if (search !== "") {
    const haystack = `${item.title} ${item.description ?? ""}`.toLowerCase();
    if (!haystack.includes(search)) return false;
  }
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
      if (f.due === "week" && (t < now || t > now + 7 * DAY_MS)) return false;
    }
  }
  if (f.tags.length > 0) {
    const itemTagIds = item.tags.map((tag) => tag.id);
    if (!f.tags.some((id) => itemTagIds.includes(id))) return false;
  }
  if (f.repo !== null) {
    if (f.repo === NO_REPO_FILTER) {
      if (item.repo != null) return false;
      // GitHub treats owner/repo case-insensitively, so the filter must too.
    } else if (item.repo?.toLowerCase() !== f.repo.toLowerCase()) {
      return false;
    }
  }
  return true;
}

const DUE_OPTIONS_LABEL_KEYS: Record<DueFilter, TranslationKey> = {
  overdue: "taskBoard.taskFilters.dueDateFilterOverdue",
  today: "taskBoard.taskFilters.dueDateFilterDueToday",
  week: "taskBoard.taskFilters.dueDateFilterDueThisWeek",
  none: "taskBoard.taskFilters.dueDateFilterNoDueDate",
};

/**
 * Shared trigger styling — a compact chip that fills in when a value is set.
 * `block` makes it a full-width row for the mobile filter drawer.
 */
function chipClass(active: boolean, block = false): string {
  return cn(
    "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium outline-none transition-colors",
    block && "h-10 w-full justify-start px-3 text-sm",
    active
      ? "border-transparent bg-accent text-foreground"
      : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground",
  );
}

function AssigneeFilter({
  value,
  members,
  onChange,
  block,
}: {
  value: string | null;
  members: Member[];
  onChange: (next: string | null) => void;
  block?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  let glyph: ReactNode = <User01 size={14} className="shrink-0" />;
  let label = t("taskBoard.taskFilters.assigneeLabel");
  if (value === UNASSIGNED_FILTER) {
    label = t("taskBoard.taskFilters.assigneeUnassigned");
  } else if (value === SUPER_AGENT_ASSIGNEE_ID) {
    glyph = <SuperAgentIcon size={14} />;
    label = t("taskBoard.taskFilters.assigneeSuperAgent");
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
    label = member?.user?.name ?? t("taskBoard.taskFilters.assigneeMember");
  }

  const select = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  const triggerClass = chipClass(value !== null, block);
  const chevronClass = cn("shrink-0 opacity-60", block && "ml-auto");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClass}>
          {glyph}
          <span className="max-w-[10rem] truncate">{label}</span>
          <ChevronDown size={12} className={chevronClass} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput
            placeholder={t("taskBoard.taskFilters.assigneeFilterPlaceholder")}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>
              {t("taskBoard.taskFilters.assigneeNoMembersFound")}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem value="Anyone" onSelect={() => select(null)}>
                {t("taskBoard.taskFilters.assigneeAnyone")}
              </CommandItem>
              <CommandItem
                value="Unassigned"
                onSelect={() => select(UNASSIGNED_FILTER)}
                className="gap-2"
              >
                <User01 size={16} className="text-muted-foreground" />
                {t("taskBoard.taskFilters.assigneeUnassigned")}
              </CommandItem>
              <CommandItem
                value="Super Agent"
                onSelect={() => select(SUPER_AGENT_ASSIGNEE_ID)}
                className="gap-2"
              >
                <SuperAgentIcon size={16} />
                {t("taskBoard.taskFilters.assigneeSuperAgent")}
              </CommandItem>
            </CommandGroup>
            <CommandGroup
              heading={t("taskBoard.taskFilters.assigneeGroupMembers")}
            >
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
  block,
}: {
  value: TaskBoardItemPriority | null;
  onChange: (next: TaskBoardItemPriority | null) => void;
  block?: boolean;
}) {
  const t = useT();
  const triggerClass = chipClass(value !== null, block);
  const chevronClass = cn("shrink-0 opacity-60", block && "ml-auto");
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
          {value
            ? t(PRIORITY_CONFIG[value].labelKey)
            : t("taskBoard.taskFilters.priorityLabel")}
          <ChevronDown size={12} className={chevronClass} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          {t("taskBoard.taskFilters.priorityAnyPriority")}
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
            {t(PRIORITY_CONFIG[p].labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DueDateFilter({
  value,
  onChange,
  block,
}: {
  value: DueFilter | null;
  onChange: (next: DueFilter | null) => void;
  block?: boolean;
}) {
  const t = useT();
  const label = value ? t(DUE_OPTIONS_LABEL_KEYS[value]) : undefined;
  const triggerClass = chipClass(value !== null, block);
  const chevronClass = cn("shrink-0 opacity-60", block && "ml-auto");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClass}>
          <Calendar size={14} className="shrink-0" />
          {label ?? t("taskBoard.taskFilters.dueDateLabel")}
          <ChevronDown size={12} className={chevronClass} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem onSelect={() => onChange(null)} className="gap-2">
          <Calendar size={16} className="text-muted-foreground" />
          {t("taskBoard.taskFilters.dueDateAnyTime")}
        </DropdownMenuItem>
        {(
          Object.entries(DUE_OPTIONS_LABEL_KEYS) as Array<
            [DueFilter, TranslationKey]
          >
        ).map(([value, labelKey]) => {
          const danger = value === "overdue";
          return (
            <DropdownMenuItem
              key={value}
              onSelect={() => onChange(value)}
              className={cn("gap-2", danger && "text-destructive")}
            >
              <Calendar
                size={16}
                className={cn(
                  "shrink-0",
                  danger ? "text-destructive" : "text-muted-foreground",
                )}
              />
              {t(labelKey)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TagFilter({
  value,
  tags,
  onChange,
  block,
}: {
  value: string[];
  tags: OrgTag[];
  onChange: (next: string[]) => void;
  block?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const toggle = (id: string) =>
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  const label =
    value.length === 0
      ? t("taskBoard.taskFilters.tagsLabel")
      : value.length === 1
        ? (tags.find((tag) => tag.id === value[0])?.name ??
          t("taskBoard.taskFilters.tagsLabel"))
        : t("taskBoard.taskFilters.tagsSelectedCount", {
            count: value.length,
          });
  const triggerClass = chipClass(value.length > 0, block);
  const chevronClass = cn("shrink-0 opacity-60", block && "ml-auto");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClass}>
          {value.length === 1 ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{
                backgroundColor: tagDotColor(
                  tags.find((tag) => tag.id === value[0])?.color,
                ),
              }}
            />
          ) : (
            <Tag01 size={14} className="shrink-0" />
          )}
          <span className="max-w-[10rem] truncate">{label}</span>
          <ChevronDown size={12} className={chevronClass} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput
            placeholder={t("taskBoard.taskFilters.tagsFilterPlaceholder")}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>
              {t("taskBoard.taskFilters.tagsNoTagsFound")}
            </CommandEmpty>
            <CommandGroup>
              {tags.map((tag) => (
                <CommandItem
                  key={tag.id}
                  value={tag.name}
                  onSelect={() => toggle(tag.id)}
                  className="gap-2"
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: tagDotColor(tag.color) }}
                  />
                  <span className="flex-1 truncate">{tag.name}</span>
                  {value.includes(tag.id) && (
                    <Check size={14} className="shrink-0 text-foreground" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RepoFilter({
  value,
  repos,
  onChange,
  block,
}: {
  value: string | null;
  repos: string[];
  onChange: (next: string | null) => void;
  block?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label =
    value === null
      ? t("taskBoard.taskFilters.repoLabel")
      : value === NO_REPO_FILTER
        ? t("taskBoard.taskFilters.repoNoRepo")
        : value;
  const select = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  const triggerClass = chipClass(value !== null, block);
  const chevronClass = cn("shrink-0 opacity-60", block && "ml-auto");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClass}>
          <GitHubIcon className="size-3.5 shrink-0" />
          <span className="max-w-[12rem] truncate">{label}</span>
          <ChevronDown size={12} className={chevronClass} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput
            placeholder={t("taskBoard.taskFilters.repoFilterPlaceholder")}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>
              {t("taskBoard.taskFilters.repoNoReposFound")}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem value="Any repo" onSelect={() => select(null)}>
                {t("taskBoard.taskFilters.repoAnyRepo")}
              </CommandItem>
              <CommandItem
                value="No repo"
                onSelect={() => select(NO_REPO_FILTER)}
              >
                {t("taskBoard.taskFilters.repoNoRepo")}
              </CommandItem>
            </CommandGroup>
            <CommandGroup>
              {repos.map((repo) => (
                <CommandItem
                  key={repo}
                  value={repo}
                  onSelect={() => select(repo)}
                  className="gap-2"
                >
                  <GitHubIcon className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{repo}</span>
                  {value === repo && (
                    <Check size={14} className="shrink-0 text-foreground" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Search toggle: a plain icon button that expands into a text input on click
 * (collapsing back once empty and blurred), rather than reserving space for a
 * full-width input at all times.
 */
function SearchToggle({
  value,
  onChange,
  block,
}: {
  value: string;
  onChange: (next: string) => void;
  block?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(value !== "");
  const expanded = open || block;

  return (
    <div
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-lg border border-border px-2.5 text-xs text-foreground transition-all duration-200 ease-out",
        expanded ? "w-32 sm:w-44" : "w-8 px-0 justify-center",
        block && "h-10 w-full px-3 text-sm sm:w-full",
      )}
    >
      <button
        type="button"
        aria-label={t("taskBoard.taskFilters.searchLabel")}
        onClick={() => setOpen(true)}
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      >
        <SearchSm size={14} />
      </button>
      {expanded && (
        <input
          autoFocus={!block}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            if (value === "") setOpen(false);
          }}
          placeholder={t("taskBoard.taskFilters.searchPlaceholder")}
          className="w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      )}
      {value !== "" && (
        <button
          type="button"
          aria-label={t("taskBoard.taskFilters.searchClearLabel")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            if (!block) setOpen(false);
          }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** The five filter controls, shared by the inline bar and the mobile drawer. */
function FilterControls({
  filters,
  members,
  tags,
  repos,
  onChange,
  block,
}: {
  filters: TaskFilters;
  members: Member[];
  tags: OrgTag[];
  repos: string[];
  onChange: (next: TaskFilters) => void;
  block?: boolean;
}) {
  return (
    <>
      <SearchToggle
        block={block}
        value={filters.search}
        onChange={(search) => onChange({ ...filters, search })}
      />
      <AssigneeFilter
        block={block}
        value={filters.assignee}
        members={members}
        onChange={(assignee) => onChange({ ...filters, assignee })}
      />
      <PriorityFilter
        block={block}
        value={filters.priority}
        onChange={(priority) => onChange({ ...filters, priority })}
      />
      <DueDateFilter
        block={block}
        value={filters.due}
        onChange={(due) => onChange({ ...filters, due })}
      />
      <TagFilter
        block={block}
        value={filters.tags}
        tags={tags}
        onChange={(tags) => onChange({ ...filters, tags })}
      />
      {/* Keep the control mounted while a repo filter is active even if the
          option list empties (last repo connection removed) — otherwise it
          silently hides tasks with no visible chip to clear. */}
      {(repos.length > 0 || filters.repo !== null) && (
        <RepoFilter
          block={block}
          value={filters.repo}
          repos={repos}
          onChange={(repo) => onChange({ ...filters, repo })}
        />
      )}
    </>
  );
}

/** Inline filter bar for desktop widths. */
export function TaskFiltersBar({
  filters,
  members,
  tags,
  repos,
  onChange,
}: {
  filters: TaskFilters;
  members: Member[];
  tags: OrgTag[];
  repos: string[];
  onChange: (next: TaskFilters) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterLines
        size={16}
        className="mr-0.5 shrink-0 text-muted-foreground"
      />
      <FilterControls
        filters={filters}
        members={members}
        tags={tags}
        repos={repos}
        onChange={onChange}
      />
      {hasActiveFilters(filters) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="ml-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("taskBoard.taskFilters.clearButton")}
        </button>
      )}
    </div>
  );
}

/**
 * Mobile filters: a single button (with an active-count badge) that opens a
 * bottom drawer holding the controls full-width — instead of the inline bar
 * wrapping across several rows on a narrow header.
 */
export function TaskFiltersDrawer({
  filters,
  members,
  tags,
  repos,
  onChange,
}: {
  filters: TaskFilters;
  members: Member[];
  tags: OrgTag[];
  repos: string[];
  onChange: (next: TaskFilters) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);
  const triggerClass = chipClass(count > 0);
  return (
    <Drawer open={open} onOpenChange={setOpen} direction="bottom">
      <DrawerTrigger asChild>
        <button type="button" className={triggerClass}>
          <FilterLines size={14} className="shrink-0" />
          {t("taskBoard.taskFilters.filterDrawerButtonLabel")}
          {count > 0 && (
            <span className="ml-0.5 flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] font-semibold text-background">
              {count}
            </span>
          )}
        </button>
      </DrawerTrigger>
      <DrawerContent className="p-0">
        <DrawerTitle className="px-4 pt-4 text-base font-medium text-foreground">
          {t("taskBoard.taskFilters.filterDrawerTitle")}
        </DrawerTitle>
        <div className="flex flex-col gap-2 p-4">
          <FilterControls
            block
            filters={filters}
            members={members}
            tags={tags}
            repos={repos}
            onChange={onChange}
          />
        </div>
        <DrawerFooter className="flex-row gap-2">
          {count > 0 && (
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => onChange(EMPTY_FILTERS)}
            >
              {t("taskBoard.taskFilters.clearAllButton")}
            </Button>
          )}
          <DrawerClose asChild>
            <Button className="flex-1">
              {t("taskBoard.taskFilters.doneButton")}
            </Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
