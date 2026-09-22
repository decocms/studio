/**
 * The board's view controls, in Linear's shape.
 *
 * Filtering is not a row of chips you read past to reach the board. It is one
 * button that opens a searchable menu, and — once something is set — a strip of
 * chips under the view row saying what is being hidden. That is the whole
 * reason the header has room for a breadcrumb and a primary action: the six
 * pickers that used to sit there are a menu now.
 *
 * With an empty query the menu lists the FIELDS, and hovering one opens its
 * values in a panel beside the row. With a query it flattens to `Field › Value`
 * rows across every field, each carrying how many cards it would leave — so
 * "high" finds `Priority › High` without anyone knowing which picker owned it.
 */

import { useState, type ReactNode } from "react";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  commandItemVariants,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  AtSign,
  Calendar,
  Check,
  ChevronRight,
  FilterLines,
  Flag01,
  Plus,
  Settings02,
  Tag01,
  User01,
  X,
} from "@untitledui/icons";
import { ProjectEntryIcon } from "@/components/project-entry";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Separator } from "@decocms/ui/components/separator.tsx";
import { useT } from "@/i18n/use-t.ts";
import { getInitials } from "@/lib/get-initials";
import {
  entryForFilter,
  NO_PROJECT_FILTER,
  type ProjectIndex,
} from "@/lib/project-index";
import {
  PRIORITIES,
  PRIORITY_CONFIG,
  SUPER_AGENT_ASSIGNEE_ID,
  tagDotColor,
  type Member,
  type OrgTag,
  type TaskBoardItem,
} from "./config";
import {
  activeFilterFieldIds,
  withFieldCleared,
  type FilterFieldId,
} from "./filter-fields";
import {
  DUE_FILTERS,
  dueFilterLabelKey,
  EMPTY_FILTERS,
  taskMatchesFilters,
  UNASSIGNED_FILTER,
  type TaskFilters,
} from "./task-filters-core";

interface FilterOption {
  /** Unique within its field — the cmdk row key, so it must not collide. */
  id: string;
  label: string;
  glyph: ReactNode;
  apply: (filters: TaskFilters) => TaskFilters;
  /** Whether this value is one the board is already narrowed by. */
  isSelected: (filters: TaskFilters) => boolean;
}

interface FilterField {
  id: FilterFieldId;
  label: string;
  icon: ReactNode;
  options: FilterOption[];
  /** The chip's value side, for whatever is currently set. */
  valueLabel: (filters: TaskFilters) => string;
  valueGlyph: (filters: TaskFilters) => ReactNode;
  /** Tags match ANY of several, so its chip reads "is any of". */
  multi?: boolean;
}

function PriorityDot({ priority }: { priority: keyof typeof PRIORITY_CONFIG }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        PRIORITY_CONFIG[priority].dotClassName,
      )}
    />
  );
}

function TagDot({ color }: { color: string | null | undefined }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: tagDotColor(color) }}
    />
  );
}

function useFilterFields({
  members,
  tags,
  index,
}: {
  members: Member[];
  tags: OrgTag[];
  index: ProjectIndex;
}): FilterField[] {
  const t = useT();

  const memberName = (userId: string) =>
    members.find((m) => m.userId === userId)?.user?.name ??
    t("taskBoard.taskFilters.assigneeMember");

  const assignee: FilterField = {
    id: "assignee",
    label: t("taskBoard.taskFilters.assigneeLabel"),
    icon: <User01 size={14} className="shrink-0" />,
    options: [
      {
        id: UNASSIGNED_FILTER,
        label: t("taskBoard.taskFilters.assigneeUnassigned"),
        glyph: <User01 size={14} className="shrink-0 text-muted-foreground" />,
        apply: (f) => ({ ...f, assignee: UNASSIGNED_FILTER }),
        isSelected: (f) => f.assignee === UNASSIGNED_FILTER,
      },
      {
        id: SUPER_AGENT_ASSIGNEE_ID,
        label: t("taskBoard.taskFilters.assigneeSuperAgent"),
        glyph: <SuperAgentIcon size={14} />,
        apply: (f) => ({ ...f, assignee: SUPER_AGENT_ASSIGNEE_ID }),
        isSelected: (f) => f.assignee === SUPER_AGENT_ASSIGNEE_ID,
      },
      ...members.map((member) => ({
        id: member.userId,
        label: member.user?.name ?? member.userId,
        glyph: (
          <Avatar
            url={member.user?.image ?? undefined}
            fallback={getInitials(member.user?.name)}
            shape="circle"
            size="2xs"
          />
        ),
        apply: (f: TaskFilters) => ({ ...f, assignee: member.userId }),
        isSelected: (f: TaskFilters) => f.assignee === member.userId,
      })),
    ],
    valueLabel: (f) =>
      f.assignee === UNASSIGNED_FILTER
        ? t("taskBoard.taskFilters.assigneeUnassigned")
        : f.assignee === SUPER_AGENT_ASSIGNEE_ID
          ? t("taskBoard.taskFilters.assigneeSuperAgent")
          : f.assignee
            ? memberName(f.assignee)
            : "",
    valueGlyph: (f) =>
      f.assignee === SUPER_AGENT_ASSIGNEE_ID ? (
        <SuperAgentIcon size={14} />
      ) : (
        <User01 size={14} className="shrink-0" />
      ),
  };

  const priority: FilterField = {
    id: "priority",
    label: t("taskBoard.taskFilters.priorityLabel"),
    icon: <Flag01 size={14} className="shrink-0" />,
    options: PRIORITIES.map((p) => ({
      id: p,
      label: t(PRIORITY_CONFIG[p].labelKey),
      glyph: <PriorityDot priority={p} />,
      apply: (f: TaskFilters) => ({ ...f, priority: p }),
      isSelected: (f: TaskFilters) => f.priority === p,
    })),
    valueLabel: (f) =>
      f.priority ? t(PRIORITY_CONFIG[f.priority].labelKey) : "",
    valueGlyph: (f) =>
      f.priority ? <PriorityDot priority={f.priority} /> : null,
  };

  const due: FilterField = {
    id: "due",
    label: t("taskBoard.taskFilters.dueDateLabel"),
    icon: <Calendar size={14} className="shrink-0" />,
    options: DUE_FILTERS.map((value) => ({
      id: value,
      label: t(dueFilterLabelKey(value)),
      glyph: (
        <Calendar
          size={14}
          className={cn(
            "shrink-0",
            value === "overdue" ? "text-destructive" : "text-muted-foreground",
          )}
        />
      ),
      apply: (f: TaskFilters) => ({ ...f, due: value }),
      isSelected: (f: TaskFilters) => f.due === value,
    })),
    valueLabel: (f) => (f.due ? t(dueFilterLabelKey(f.due)) : ""),
    valueGlyph: () => <Calendar size={14} className="shrink-0" />,
  };

  const tagField: FilterField = {
    id: "tags",
    label: t("taskBoard.taskFilters.tagsLabel"),
    icon: <Tag01 size={14} className="shrink-0" />,
    multi: true,
    options: tags.map((tag) => ({
      id: tag.id,
      label: tag.name,
      glyph: <TagDot color={tag.color} />,
      apply: (f: TaskFilters) => ({
        ...f,
        tags: f.tags.includes(tag.id)
          ? f.tags.filter((id) => id !== tag.id)
          : [...f.tags, tag.id],
      }),
      isSelected: (f: TaskFilters) => f.tags.includes(tag.id),
    })),
    valueLabel: (f) =>
      f.tags.length === 1
        ? (tags.find((tag) => tag.id === f.tags[0])?.name ??
          t("taskBoard.taskFilters.tagsLabel"))
        : t("taskBoard.taskFilters.tagsSelectedCount", {
            count: f.tags.length,
          }),
    valueGlyph: (f) =>
      f.tags.length === 1 ? (
        <TagDot color={tags.find((tag) => tag.id === f.tags[0])?.color} />
      ) : (
        <Tag01 size={14} className="shrink-0" />
      ),
  };

  const project: FilterField = {
    id: "project",
    label: t("taskBoard.taskFilters.projectLabel"),
    icon: <ProjectEntryIcon entry={undefined} />,
    options: [
      {
        id: NO_PROJECT_FILTER,
        label: t("taskBoard.taskFilters.projectNone"),
        glyph: <ProjectEntryIcon entry={undefined} />,
        apply: (f) => ({ ...f, project: NO_PROJECT_FILTER }),
        isSelected: (f) => f.project === NO_PROJECT_FILTER,
      },
      ...index.entries.map((entry) => ({
        id: entry.id,
        label: entry.title,
        glyph: <ProjectEntryIcon entry={entry} />,
        apply: (f: TaskFilters) => ({ ...f, project: entry.id }),
        isSelected: (f: TaskFilters) => f.project === entry.id,
      })),
    ],
    valueLabel: (f) =>
      f.project === NO_PROJECT_FILTER
        ? t("taskBoard.taskFilters.projectNone")
        : f.project
          ? (entryForFilter(f.project, index)?.title ?? f.project)
          : "",
    valueGlyph: (f) => (
      <ProjectEntryIcon
        entry={f.project ? entryForFilter(f.project, index) : undefined}
      />
    ),
  };

  return [assignee, priority, due, tagField, project];
}

/** How many cards a choice would leave, right-aligned like Linear's. */
function MatchCount({ count }: { count: number }) {
  const t = useT();
  return (
    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
      {t("taskBoard.viewControls.matchCount", { count })}
    </span>
  );
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {children}
    </span>
  );
}

/** A field whose values open in a panel BESIDE the row, on hover, Linear-style. */
function FieldSubmenu({
  field,
  open,
  countFor,
  onSelect,
}: {
  field: FilterField;
  open: boolean;
  countFor: (option: FilterOption) => number;
  onSelect: (option: FilterOption) => void;
}) {
  return (
    <Popover open={open}>
      {/* The ROW is the anchor, so the panel tracks it down the list. */}
      <PopoverAnchor asChild>
        <CommandItem value={field.label}>
          <Glyph>{field.icon}</Glyph>
          <span className="truncate">{field.label}</span>
          <ChevronRight
            size={12}
            className="ml-auto shrink-0 text-muted-foreground/60"
          />
        </CommandItem>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        alignOffset={-5}
        className="max-h-72 w-64 overflow-y-auto p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {field.options.map((option) => (
          <ValueRow
            key={option.id}
            option={option}
            count={countFor(option)}
            onSelect={() => onSelect(option)}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** One value of an already-named field, so the row carries the value alone. */
function ValueRow({
  option,
  count,
  onSelect,
}: {
  option: FilterOption;
  count: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(commandItemVariants({ highlight: "hover" }))}
      onClick={onSelect}
    >
      <Glyph>{option.glyph}</Glyph>
      <span className="truncate">{option.label}</span>
      <MatchCount count={count} />
    </button>
  );
}

/** A cross-field search hit. Here the field name IS the information: it says
 *  which picker the match came out of. */
function FlatRow({
  field,
  option,
  count,
  onSelect,
}: {
  field: FilterField;
  option: FilterOption;
  count: number;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={`${field.label} ${option.label}`} onSelect={onSelect}>
      <Glyph>{field.icon}</Glyph>
      <span className="shrink-0 text-muted-foreground">{field.label}</span>
      <ChevronRight size={12} className="shrink-0 text-muted-foreground/60" />
      <Glyph>{option.glyph}</Glyph>
      <span className="truncate">{option.label}</span>
      <MatchCount count={count} />
    </CommandItem>
  );
}

/** Arrowing counts as browsing too; a just-opened menu is neither, and cmdk always has a row selected. */
const BROWSE_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowRight"]);

type MentionFilter = { active: boolean; toggle: () => void };

function FilterMenu({
  filters,
  items,
  index,
  fields,
  onChange,
  onClose,
  mentions,
}: {
  mentions?: MentionFilter;
  filters: TaskFilters;
  items: TaskBoardItem[];
  index: ProjectIndex;
  fields: FilterField[];
  onChange: (next: TaskFilters) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const select = (field: FilterField, option: FilterOption) => {
    onChange(option.apply(filters));
    // Tags accumulate, so its panel stays open for the next one.
    if (!field.multi) onClose();
  };

  const countFor = (option: FilterOption) =>
    items.filter((item) =>
      taskMatchesFilters(item, option.apply(filters), index),
    ).length;

  // An org with no tags has no tag filter: the field would open onto nothing.
  const offered = fields.filter((field) => field.options.length > 0);

  return (
    <Command
      value={active}
      onValueChange={setActive}
      onKeyDown={(event) => {
        if (BROWSE_KEYS.has(event.key)) setBrowsing(true);
      }}
    >
      <CommandInput
        size="sm"
        value={query}
        onValueChange={setQuery}
        placeholder={t("taskBoard.viewControls.addFilter")}
        aria-label={t("taskBoard.viewControls.addFilter")}
        className="h-9"
      />
      <CommandList onPointerMove={() => setBrowsing(true)}>
        <CommandEmpty>{t("taskBoard.viewControls.noMatches")}</CommandEmpty>
        {mentions && (
          <CommandGroup>
            <CommandItem
              value={t("taskBoard.forum.mentions")}
              onSelect={() => {
                mentions.toggle();
                onClose();
              }}
            >
              <AtSign size={16} />
              <span>{t("taskBoard.forum.mentions")}</span>
              {mentions.active && <Check size={14} className="ml-auto" />}
            </CommandItem>
          </CommandGroup>
        )}
        {query.trim() === "" ? (
          <CommandGroup>
            {offered.map((field) => (
              <FieldSubmenu
                key={field.id}
                field={field}
                open={browsing && active === field.label}
                countFor={countFor}
                onSelect={(option) => select(field, option)}
              />
            ))}
          </CommandGroup>
        ) : (
          <CommandGroup>
            {offered.flatMap((field) =>
              field.options.map((option) => (
                <FlatRow
                  key={`${field.id}:${option.id}`}
                  field={field}
                  option={option}
                  count={countFor(option)}
                  onSelect={() => select(field, option)}
                />
              )),
            )}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

function FilterMenuPopover({
  trigger,
  ...menu
}: {
  trigger: ReactNode;
  mentions?: MentionFilter;
  filters: TaskFilters;
  items: TaskBoardItem[];
  index: ProjectIndex;
  fields: FilterField[];
  onChange: (next: TaskFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        {open && <FilterMenu {...menu} onClose={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

/** The view row's filter button. The dot says a filter is on without making
 *  the strip below the only evidence. */
export function TaskFilterButton({
  filters,
  items,
  members,
  tags,
  index,
  onChange,
  mentions,
}: {
  mentions?: MentionFilter;
  filters: TaskFilters;
  items: TaskBoardItem[];
  members: Member[];
  tags: OrgTag[];
  index: ProjectIndex;
  onChange: (next: TaskFilters) => void;
}) {
  const t = useT();
  const fields = useFilterFields({ members, tags, index });
  const active =
    activeFilterFieldIds(filters, index).length > 0 || mentions?.active;

  return (
    <FilterMenuPopover
      mentions={mentions}
      filters={filters}
      items={items}
      index={index}
      fields={fields}
      onChange={onChange}
      trigger={
        <IconButton
          label={t("taskBoard.viewControls.filterLabel")}
          tooltipSide="bottom"
          variant="secondary"
          aria-pressed={active}
        >
          <FilterLines />
        </IconButton>
      }
    />
  );
}

/** The view row's display button — layout, then the board's own settings. */
/** The values of ONE field, reached from the chip that already names it — so
 *  changing "Priority is Medium" to High is a click on the value, not a trip
 *  back through the add-filter menu. What is set floats to the top and wears a
 *  check; the rest carry how many cards they would leave. */
function FieldValueMenu({
  field,
  filters,
  items,
  index,
  onChange,
  onClose,
}: {
  field: FilterField;
  filters: TaskFilters;
  items: TaskBoardItem[];
  index: ProjectIndex;
  onChange: (next: TaskFilters) => void;
  onClose: () => void;
}) {
  const selected = field.options.filter((option) => option.isSelected(filters));
  const rest = field.options.filter((option) => !option.isSelected(filters));

  const select = (option: FilterOption) => {
    onChange(option.apply(filters));
    // Tags accumulate, so the list stays open for the next one.
    if (!field.multi) onClose();
  };

  const row = (option: FilterOption, showCount: boolean) => (
    <button
      key={option.id}
      type="button"
      className={cn(commandItemVariants({ highlight: "hover" }))}
      onClick={() => select(option)}
    >
      <Glyph>{option.glyph}</Glyph>
      <span className="truncate">{option.label}</span>
      {showCount ? (
        <MatchCount
          count={
            items.filter((item) =>
              taskMatchesFilters(item, option.apply(filters), index),
            ).length
          }
        />
      ) : (
        <Check size={14} className="ml-auto shrink-0" />
      )}
    </button>
  );

  return (
    <div className="flex max-h-72 flex-col overflow-y-auto p-1">
      <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
        {field.label}
      </p>
      {selected.map((option) => row(option, false))}
      {selected.length > 0 && rest.length > 0 && <Separator className="my-1" />}
      {rest.map((option) => row(option, true))}
    </div>
  );
}

function FieldValuePopover({
  field,
  filters,
  items,
  index,
  onChange,
}: {
  field: FilterField;
  filters: TaskFilters;
  items: TaskBoardItem[];
  index: ProjectIndex;
  onChange: (next: TaskFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-full max-w-[12rem] items-center gap-1.5 truncate px-2.5 text-foreground hover:bg-accent"
        >
          {field.valueGlyph(filters)}
          {field.valueLabel(filters)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        {open && (
          <FieldValueMenu
            field={field}
            filters={filters}
            items={items}
            index={index}
            onChange={onChange}
            onClose={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AppliedFiltersBar({
  filters,
  items,
  members,
  tags,
  index,
  onChange,
}: {
  filters: TaskFilters;
  items: TaskBoardItem[];
  members: Member[];
  tags: OrgTag[];
  index: ProjectIndex;
  onChange: (next: TaskFilters) => void;
}) {
  const t = useT();
  const fields = useFilterFields({ members, tags, index });
  const activeIds = activeFilterFieldIds(filters, index);
  if (activeIds.length === 0) return null;

  return (
    <div className="mx-3 flex h-11 shrink-0 items-center gap-2 overflow-x-auto rounded-xl border border-border px-2 no-scrollbar">
      {activeIds.map((id) => {
        const field = fields.find((candidate) => candidate.id === id);
        if (!field) return null;
        return (
          <Badge key={id} variant="outline" size="segmented">
            <span className="flex h-full items-center gap-1.5 px-2.5 text-foreground">
              {field.icon}
              {field.label}
            </span>
            <Separator orientation="vertical" />
            <span className="px-2 text-muted-foreground">
              {field.multi
                ? t("taskBoard.viewControls.isAnyOf")
                : t("taskBoard.viewControls.is")}
            </span>
            <Separator orientation="vertical" />
            <FieldValuePopover
              field={field}
              filters={filters}
              items={items}
              index={index}
              onChange={onChange}
            />
            <IconButton
              label={t("taskBoard.viewControls.removeFilter", {
                field: field.label,
              })}
              size="icon-sm"
              onClick={() => onChange(withFieldCleared(filters, id))}
            >
              <X />
            </IconButton>
          </Badge>
        );
      })}
      <FilterMenuPopover
        filters={filters}
        items={items}
        index={index}
        fields={fields}
        onChange={onChange}
        trigger={
          <IconButton label={t("taskBoard.viewControls.addAnotherFilter")}>
            <Plus />
          </IconButton>
        }
      />
      <div className="ml-auto">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ ...EMPTY_FILTERS, search: filters.search })}
        >
          {t("taskBoard.viewControls.clear")}
        </Button>
      </div>
    </div>
  );
}

export function BoardSettingsButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  const label = t("taskBoard.taskFilters.boardSettingsLabel");

  return (
    <IconButton
      label={label}
      tooltipSide="bottom"
      variant="secondary"
      onClick={onClick}
    >
      <Settings02 />
    </IconButton>
  );
}
