/**
 * Task board filters — assignee, priority and due date. Filtering is pure
 * (`taskMatchesFilters`) so both the board and list views share it, and the
 * bar is presentational: it owns no state beyond the open/closed popovers.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { currentSprintId } from "@decocms/shared/sprints";
import { parseTaskKeySeq } from "@decocms/shared/task-key";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
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
  Repeat04,
  SearchSm,
  Settings02,
  Tag01,
  User01,
  X,
} from "@untitledui/icons";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { ProjectEntryIcon, ProjectEntryRow } from "@/components/project-entry";
import { getInitials } from "@/lib/get-initials";
import {
  entryForFilter,
  NO_PROJECT_FILTER,
  projectFilterNarrows,
  taskMatchesProjectFilter,
  type ProjectIndex,
  type ProjectIndexEntry,
} from "@/lib/project-index";
import {
  formatSprintDates,
  type Sprint,
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

/** Sentinel sprint filter matching cards in no sprint (the backlog). Shares the
 *  namespace with sprint ids, which are `sprint_`-prefixed, so it can't collide. */
const BACKLOG_FILTER = "backlog";

/** Sentinel for "every sprint", which has to be SAID rather than implied by an
 *  absent param: absence is what selects the running sprint, so without this the
 *  Any-sprint option would drop out of the URL and default straight back. */
const ALL_SPRINTS_FILTER = "all";

/** Radix `RadioGroup` needs a string value — this stands in for `null` (any). */
const ANY_FILTER = "__any__";

export type DueFilter = "overdue" | "today" | "week" | "none";

export type TaskFilters = {
  /** userId | SUPER_AGENT_ASSIGNEE_ID | UNASSIGNED_FILTER | null (anyone) */
  assignee: string | null;
  priority: TaskBoardItemPriority | null;
  due: DueFilter | null;
  /** Org tag ids — a task matches if it has at least one of these. */
  tags: string[];
  /** A project index bucket id — `owner/name`, a `vir_…` project with no
   *  repository, {@link NO_PROJECT_FILTER}, or null for every project. */
  project: string | null;
  /** Sprint id | BACKLOG_FILTER (no sprint) | null (any sprint) */
  sprint: string | null;
  /** Free-text match against title/description, empty string = no filter. */
  search: string;
};

export const EMPTY_FILTERS: TaskFilters = {
  assignee: null,
  priority: null,
  due: null,
  tags: [],
  project: null,
  sprint: null,
  search: "",
};

/**
 * The sprint filter this board should apply, given what the URL says.
 *
 * A board that runs sprints opens on the running one, the way Jira does, so an
 * absent param is not "no filter" — it is "nobody has chosen yet". Every sprint
 * is reachable only through {@link ALL_SPRINTS_FILTER}, which is the whole
 * reason that sentinel exists.
 *
 * An unresolvable id resolves like an absent one. The URL outlives the sprint it
 * names — a shared link, a bookmark, a sprint deleted in Jira — and left in
 * place it hides every card behind a chip that reads like "no filter". Falling
 * back to the default keeps a single rule: you see every sprint only by asking.
 *
 * Call it only once the sprints have loaded, or an in-flight read would drop a
 * filter that is about to be valid.
 */
export function resolveSprintFilter(
  value: string | null,
  sprints: readonly Sprint[],
): string | null {
  if (value === ALL_SPRINTS_FILTER) return null;
  if (value === BACKLOG_FILTER) return value;
  if (value !== null && sprints.some((sprint) => sprint.id === value)) {
    return value;
  }
  return currentSprintId(sprints);
}

/**
 * Whether the sprint scope is one the user narrowed to, as opposed to the board
 * opening on its running sprint. The default must not count: it would light up
 * "Clear" on a board nobody filtered, and clearing cannot remove it — the reset
 * writes an absent param, which is exactly what re-selects the default.
 *
 * Picking the running sprint by hand lands on the same state and so reads as
 * the default. Indistinguishable and harmless: the board shows the same cards.
 */
function sprintNarrowed(f: TaskFilters, defaultSprint: string | null): boolean {
  return f.sprint !== null && f.sprint !== defaultSprint;
}

function hasActiveFilters(
  f: TaskFilters,
  defaultSprint: string | null,
): boolean {
  return (
    f.assignee !== null ||
    f.priority !== null ||
    f.due !== null ||
    f.tags.length > 0 ||
    f.project !== null ||
    sprintNarrowed(f, defaultSprint) ||
    f.search.trim() !== ""
  );
}

function activeFilterCount(
  f: TaskFilters,
  defaultSprint: string | null,
): number {
  return (
    (f.assignee !== null ? 1 : 0) +
    (f.priority !== null ? 1 : 0) +
    (f.due !== null ? 1 : 0) +
    (f.tags.length > 0 ? 1 : 0) +
    (f.project !== null ? 1 : 0) +
    (sprintNarrowed(f, defaultSprint) ? 1 : 0) +
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

/** A term written as a bare number — the shorthand both key vocabularies take. */
const BARE_SEQ = /^0*(\d+)$/;

/**
 * True when the term names this card by the key it SHOWS (see `taskKey`).
 *
 * A card synced from a tracker shows the tracker's key, so that is the only
 * lettered key it answers to. Falling through to the sequence would be worse
 * than useless: `parseTaskKeySeq` ignores the prefix, so searching `EX-333`
 * would quietly match whichever unrelated card happens to hold Studio sequence
 * 333, and miss the one actually named that.
 *
 * A bare number still works either way, since it is ambiguous by construction
 * and a search returning both readings of it is the honest answer.
 */
export function matchesTaskKey(
  search: string,
  keySeq: number | null | undefined,
  trackerKey?: string | null,
): boolean {
  const term = search.trim();
  if (term === "") return false;
  const tracker = trackerKey?.trim();
  if (tracker) {
    if (term.toLowerCase() === tracker.toLowerCase()) return true;
    const bare = BARE_SEQ.exec(term)?.[1];
    return bare !== undefined && Number(bare) === parseTaskKeySeq(tracker);
  }
  return keySeq != null && parseTaskKeySeq(term) === keySeq;
}

/**
 * Whether a card belongs to `userId`, delegation included.
 *
 * Handing a card to the Super Agent does not hand it away: the board renders
 * the delegator's avatar beside the capybara, so a card that reads as "mine and
 * the Super Agent's" has to survive filtering by me. Delegation counts only on
 * Super Agent cards — `assignedBy` is stamped on every assignee change, so a
 * card one teammate assigned to another is the assignee's, not the assigner's.
 */
function assignedTo(item: TaskBoardItem, userId: string): boolean {
  if (item.assigneeId === userId) return true;
  return (
    item.assigneeId === SUPER_AGENT_ASSIGNEE_ID && item.assignedBy === userId
  );
}

/** `index` is required rather than defaulted: an empty index answers the
 *  no-project bucket with "every card", and a caller that forgot it would
 *  quietly turn one filter into no filter. */
export function taskMatchesFilters(
  item: TaskBoardItem,
  f: TaskFilters,
  index: ProjectIndex,
): boolean {
  const search = f.search.trim().toLowerCase();
  if (search !== "") {
    const haystack = `${item.title} ${item.description ?? ""}`.toLowerCase();
    if (
      !haystack.includes(search) &&
      !matchesTaskKey(search, item.keySeq, item.jiraIssueKey)
    ) {
      return false;
    }
  }
  if (f.assignee !== null) {
    if (f.assignee === UNASSIGNED_FILTER) {
      if (item.assigneeId !== null) return false;
    } else if (!assignedTo(item, f.assignee)) {
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
  if (!taskMatchesProjectFilter(item, f.project, index)) return false;
  if (f.sprint !== null) {
    if (f.sprint === BACKLOG_FILTER) {
      if (item.sprintId != null) return false;
    } else if (item.sprintId !== f.sprint) {
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
    "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20",
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
            aria-label={t("taskBoard.taskFilters.assigneeFilterPlaceholder")}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>
              {t("taskBoard.taskFilters.assigneeNoMembersFound")}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={t("taskBoard.taskFilters.assigneeAnyone")}
                onSelect={() => select(null)}
              >
                {t("taskBoard.taskFilters.assigneeAnyone")}
              </CommandItem>
              <CommandItem
                value={t("taskBoard.taskFilters.assigneeUnassigned")}
                onSelect={() => select(UNASSIGNED_FILTER)}
                className="gap-2"
              >
                <User01 size={16} className="text-muted-foreground" />
                {t("taskBoard.taskFilters.assigneeUnassigned")}
              </CommandItem>
              <CommandItem
                value={t("taskBoard.taskFilters.assigneeSuperAgent")}
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
        <DropdownMenuRadioGroup
          value={value ?? ANY_FILTER}
          onValueChange={(next) =>
            onChange(
              next === ANY_FILTER ? null : (next as TaskBoardItemPriority),
            )
          }
        >
          <DropdownMenuRadioItem value={ANY_FILTER}>
            {t("taskBoard.taskFilters.priorityAnyPriority")}
          </DropdownMenuRadioItem>
          {PRIORITIES.map((p) => (
            <DropdownMenuRadioItem key={p} value={p} className="gap-2">
              <span
                className={cn(
                  "size-2 rounded-full",
                  PRIORITY_CONFIG[p].dotClassName,
                )}
              />
              {t(PRIORITY_CONFIG[p].labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
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
        <DropdownMenuRadioGroup
          value={value ?? ANY_FILTER}
          onValueChange={(next) =>
            onChange(next === ANY_FILTER ? null : (next as DueFilter))
          }
        >
          <DropdownMenuRadioItem value={ANY_FILTER} className="gap-2">
            <Calendar size={16} className="text-muted-foreground" />
            {t("taskBoard.taskFilters.dueDateAnyTime")}
          </DropdownMenuRadioItem>
          {(
            Object.entries(DUE_OPTIONS_LABEL_KEYS) as Array<
              [DueFilter, TranslationKey]
            >
          ).map(([due, labelKey]) => {
            const danger = due === "overdue";
            return (
              <DropdownMenuRadioItem
                key={due}
                value={due}
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
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
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
            aria-label={t("taskBoard.taskFilters.tagsFilterPlaceholder")}
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

/** One bucket's row. How it presents itself — project avatar and name, or the
 *  repository's glyph when no single project names it — is
 *  {@link ProjectEntryRow}'s to decide, shared with the task detail's picker. */
function ProjectOption({
  entry,
  selected,
  onSelect,
}: {
  entry: ProjectIndexEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      /**
       * The bucket id leads, because cmdk keys a row's HIGHLIGHT on this string
       * and nothing else: two repo-less projects both titled "Docs" would
       * otherwise share a value, so both would render selected, arrow-down
       * could not move between them, and Enter would fire whichever came first
       * in the DOM. The rest of the string is what the row is searchable BY —
       * its name, its repository, and its siblings' names.
       */
      value={`${entry.id} ${entry.title} ${entry.repo ?? ""} ${entry.projects
        .map((p) => p.title)
        .join(" ")}`}
      onSelect={onSelect}
      className="gap-2"
    >
      <ProjectEntryRow entry={entry} />
      {selected && <Check size={14} className="shrink-0 text-foreground" />}
    </CommandItem>
  );
}

/**
 * The filter chip's own label, which has to agree with what the board is
 * actually doing.
 *
 * A `vir_…` the index cannot resolve — the first frame, or a link naming a
 * project since deleted — lets every card through, so the chip reads UNSET
 * rather than echoing the raw id back. A chip showing `vir_01j9x…` over a
 * board that is not narrowed is the one label here that can mislead. An
 * unresolved repo-shaped id still narrows (an exact compare against the card's
 * own `repo`), so that one keeps saying what it filters by.
 */
function projectChipLabel(
  value: string | null,
  entry: ProjectIndexEntry | undefined,
  narrows: boolean,
  t: ReturnType<typeof useT>,
): string {
  if (value === null || !narrows)
    return t("taskBoard.taskFilters.projectLabel");
  if (value === NO_PROJECT_FILTER)
    return t("taskBoard.taskFilters.projectNone");
  return entry?.title ?? value;
}

/**
 * The board's project filter — the control that used to say "Repo".
 *
 * Its option set is the project index, so a repository is offered as the
 * project that pins it and picking one IS picking a project. A repository no
 * project claims is still offered, under its own heading: the board must be
 * able to narrow to work that exists.
 */
function ProjectFilter({
  value,
  index,
  onChange,
  block,
}: {
  value: string | null;
  index: ProjectIndex;
  onChange: (next: string | null) => void;
  block?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const selected = value === null ? undefined : entryForFilter(value, index);
  const narrows = projectFilterNarrows(value, index);
  const label = projectChipLabel(value, selected, narrows, t);
  const select = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  const claimed = index.entries.filter((entry) => entry.projects.length > 0);
  const unclaimed = index.entries.filter(
    (entry) => entry.projects.length === 0,
  );
  /** `narrows`, not `value !== null`: the chip must look set only when the
   *  board is actually narrowed. */
  const triggerClass = chipClass(narrows, block);
  const chevronClass = cn("shrink-0 opacity-60", block && "ml-auto");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClass}>
          {/* The glyph follows the label: an unresolved bucket reads as unset,
              so it must not wear a project's face either. */}
          <ProjectEntryIcon entry={narrows ? selected : undefined} />
          <span className="max-w-[12rem] truncate">{label}</span>
          <ChevronDown size={12} className={chevronClass} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput
            placeholder={t("taskBoard.taskFilters.projectFilterPlaceholder")}
            aria-label={t("taskBoard.taskFilters.projectFilterPlaceholder")}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>
              {t("taskBoard.taskFilters.projectNoneFound")}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={t("taskBoard.taskFilters.projectAny")}
                onSelect={() => select(null)}
              >
                {t("taskBoard.taskFilters.projectAny")}
              </CommandItem>
              <CommandItem
                value={t("taskBoard.taskFilters.projectNone")}
                onSelect={() => select(NO_PROJECT_FILTER)}
              >
                {t("taskBoard.taskFilters.projectNone")}
              </CommandItem>
            </CommandGroup>
            {claimed.length > 0 && (
              <CommandGroup
                heading={t("taskBoard.taskFilters.projectGroupProjects")}
              >
                {claimed.map((entry) => (
                  <ProjectOption
                    key={entry.id}
                    entry={entry}
                    selected={value === entry.id}
                    onSelect={() => select(entry.id)}
                  />
                ))}
              </CommandGroup>
            )}
            {unclaimed.length > 0 && (
              <CommandGroup
                heading={t("taskBoard.taskFilters.projectGroupRepos")}
              >
                {unclaimed.map((entry) => (
                  <ProjectOption
                    key={entry.id}
                    entry={entry}
                    selected={value === entry.id}
                    onSelect={() => select(entry.id)}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SprintFilter({
  value,
  sprints,
  onChange,
  block,
}: {
  value: string | null;
  /** Sprints to offer, in reading order (running → next → past). */
  sprints: Sprint[];
  /** Always a stored value — `ALL_SPRINTS_FILTER`, never a bare null. */
  onChange: (next: string) => void;
  block?: boolean;
}) {
  const t = useT();
  const selected = sprints.find((sprint) => sprint.id === value);
  const label =
    value === null
      ? t("taskBoard.taskFilters.sprintLabel")
      : value === BACKLOG_FILTER
        ? t("taskBoard.taskFilters.sprintBacklog")
        : // A filter can outlive its sprint (a stored URL, a deleted sprint).
          (selected?.name ?? t("taskBoard.taskFilters.sprintLabel"));
  const triggerClass = chipClass(value !== null, block);
  const chevronClass = cn("shrink-0 opacity-60", block && "ml-auto");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClass}>
          <Repeat04 size={14} className="shrink-0" />
          {label}
          <ChevronDown size={12} className={chevronClass} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 w-72 overflow-y-auto"
      >
        <DropdownMenuRadioGroup
          value={value === null ? ANY_FILTER : value}
          onValueChange={(next) =>
            onChange(next === ANY_FILTER ? ALL_SPRINTS_FILTER : next)
          }
        >
          <DropdownMenuRadioItem value={ANY_FILTER}>
            {t("taskBoard.taskFilters.sprintAnySprint")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value={BACKLOG_FILTER}>
            {t("taskBoard.taskFilters.sprintBacklog")}
          </DropdownMenuRadioItem>
          {sprints.map((sprint) => (
            <DropdownMenuRadioItem key={sprint.id} value={sprint.id}>
              <span className="truncate">{sprint.name}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {sprint.state === "active"
                  ? t("taskBoard.taskFilters.sprintCurrent")
                  : formatSprintDates(sprint)}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const [focused, setFocused] = useState(false);

  // Collapse a filter cleared externally while unfocused (not one emptied by typing).
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    if (value === "" && !focused) setOpen(false);
  }

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
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (value === "") setOpen(false);
          }}
          placeholder={t("taskBoard.taskFilters.searchPlaceholder")}
          aria-label={t("taskBoard.taskFilters.searchPlaceholder")}
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

/**
 * Button to the board's settings page. Navigation itself is the caller's
 * job (passed in as `onClick`) — this component stays presentational like
 * the rest of the bar, with no router or org dependency of its own.
 *
 * Icon-only with a hover tooltip in the inline bar; in the mobile drawer
 * (`block`) the tooltip never shows (Radix tooltips are hover/focus-only,
 * and drawer taps are touch), so it renders the label as text instead, like
 * every other drawer control.
 */
function BoardSettingsButton({
  block,
  onClick,
}: {
  block?: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const label = t("taskBoard.taskFilters.boardSettingsLabel");
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        chipClass(false, block),
        block ? "h-10 w-full" : "w-8 justify-center px-0",
      )}
    >
      <Settings02 size={14} className="shrink-0" />
      {block && <span>{label}</span>}
    </button>
  );
  if (block) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The filter controls, shared by the inline bar and the mobile drawer. */
function FilterControls({
  filters,
  members,
  tags,
  index,
  sprints,
  onChange,
  onOpenBoardSettings,
  block,
}: {
  filters: TaskFilters;
  members: Member[];
  tags: OrgTag[];
  index: ProjectIndex;
  sprints: Sprint[];
  onChange: (next: TaskFilters) => void;
  onOpenBoardSettings: () => void;
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
      {/* Keep the control mounted while a project filter is active even if the
          option list empties (last project and repo removed) — otherwise it
          silently hides tasks with no visible chip to clear. */}
      {(index.entries.length > 0 || filters.project !== null) && (
        <ProjectFilter
          block={block}
          value={filters.project}
          index={index}
          onChange={(project) => onChange({ ...filters, project })}
        />
      )}
      {/* Same reasoning as the project control: an active sprint filter keeps its
          chip visible even when the board mirrors no sprints, so the hidden
          cards can be brought back. */}
      {(sprints.length > 0 || filters.sprint !== null) && (
        <SprintFilter
          block={block}
          value={filters.sprint}
          sprints={sprints}
          onChange={(sprint) => onChange({ ...filters, sprint })}
        />
      )}
      <BoardSettingsButton block={block} onClick={onOpenBoardSettings} />
    </>
  );
}

/** Inline filter bar for desktop widths. */
export function TaskFiltersBar({
  filters,
  members,
  tags,
  index,
  sprints,
  onChange,
  onOpenBoardSettings,
}: {
  filters: TaskFilters;
  members: Member[];
  tags: OrgTag[];
  index: ProjectIndex;
  sprints: Sprint[];
  onChange: (next: TaskFilters) => void;
  onOpenBoardSettings: () => void;
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
        index={index}
        sprints={sprints}
        onChange={onChange}
        onOpenBoardSettings={onOpenBoardSettings}
      />
      {hasActiveFilters(filters, currentSprintId(sprints)) && (
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
  index,
  sprints,
  onChange,
  onOpenBoardSettings,
}: {
  filters: TaskFilters;
  members: Member[];
  tags: OrgTag[];
  index: ProjectIndex;
  sprints: Sprint[];
  onChange: (next: TaskFilters) => void;
  onOpenBoardSettings: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters, currentSprintId(sprints));
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
            index={index}
            sprints={sprints}
            onChange={onChange}
            onOpenBoardSettings={onOpenBoardSettings}
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
