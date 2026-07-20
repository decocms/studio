import { forwardRef } from "react";
import {
  ChevronDown,
  FilterFunnel01,
  SwitchVertical01,
  Trash01,
  X,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { PostSort } from "./content-browser";

// Sentinel for the "no filter" radio option (Radix forbids empty values).
const ALL_FILTER = "__all__";

const POST_SORT_LABELS: Record<PostSort, string> = {
  "date-desc": "Newest first",
  "date-asc": "Oldest first",
  az: "Title A–Z",
  za: "Title Z–A",
};

const POST_SORT_SHORT: Record<PostSort, string> = {
  "date-desc": "Newest",
  "date-asc": "Oldest",
  az: "A–Z",
  za: "Z–A",
};

type CategoryOption = { slug: string; name: string; count: number };
type AuthorOption = { email: string; name: string; count: number };

/**
 * Compact, icon-led filter trigger: just the icon when no filter is applied,
 * icon + highlighted value once one is. Forwards props/ref so it can be used
 * directly as a `DropdownMenuTrigger asChild` child.
 */
const FilterChipTrigger = forwardRef<
  HTMLButtonElement,
  {
    icon: React.ComponentType<{ size?: number; className?: string }>;
    active: boolean;
    value?: string;
  } & React.ComponentProps<typeof Button>
>(function FilterChipTrigger(
  { icon: Icon, active, value, className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 gap-1 px-1.5 text-xs",
        active ? "text-foreground" : "text-muted-foreground",
        className,
      )}
      {...props}
    >
      <Icon size={14} className="shrink-0" />
      {value && <span className="min-w-0 flex-1 truncate">{value}</span>}
      <ChevronDown size={12} className="shrink-0 opacity-60" />
    </Button>
  );
});

function OptionCount({ count }: { count: number }) {
  return (
    <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">
      {count}
    </span>
  );
}

export function PostFilterBar({
  categories,
  authors,
  categoryFilter,
  authorFilter,
  sort,
  onCategoryFilterChange,
  onAuthorFilterChange,
  onSortChange,
}: {
  categories: CategoryOption[];
  authors: AuthorOption[];
  categoryFilter: string | null;
  authorFilter: string | null;
  sort: PostSort;
  onCategoryFilterChange: (slug: string | null) => void;
  onAuthorFilterChange: (email: string | null) => void;
  onSortChange: (sort: PostSort) => void;
}) {
  const activeCategory = categories.find((c) => c.slug === categoryFilter);
  const activeAuthor = authors.find((a) => a.email === authorFilter);
  const hasFilter = !!(categoryFilter || authorFilter);
  const activeLabel = activeCategory?.name ?? activeAuthor?.name ?? "Filter";
  // One filter at a time: encode both dimensions into a single radio value.
  const activeValue = categoryFilter
    ? `cat:${categoryFilter}`
    : authorFilter
      ? `author:${authorFilter}`
      : ALL_FILTER;
  const clearFilter = () => {
    onCategoryFilterChange(null);
    onAuthorFilterChange(null);
  };
  const handleFilterChange = (v: string) => {
    if (v.startsWith("cat:")) {
      onAuthorFilterChange(null);
      onCategoryFilterChange(v.slice(4));
    } else if (v.startsWith("author:")) {
      onCategoryFilterChange(null);
      onAuthorFilterChange(v.slice(7));
    } else {
      clearFilter();
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden border-b px-2 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <FilterChipTrigger
            icon={FilterFunnel01}
            active={hasFilter}
            value={activeLabel}
            className="min-w-0 shrink"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-96 w-60 overflow-y-auto"
        >
          <DropdownMenuLabel>Filter by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activeValue}
            onValueChange={handleFilterChange}
          >
            <DropdownMenuRadioItem value={ALL_FILTER}>
              All posts
            </DropdownMenuRadioItem>
            {categories.length > 0 && (
              <DropdownMenuLabel className="text-muted-foreground/70">
                Category
              </DropdownMenuLabel>
            )}
            {categories.map((c) => (
              <DropdownMenuRadioItem
                key={`cat:${c.slug}`}
                value={`cat:${c.slug}`}
              >
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <OptionCount count={c.count} />
              </DropdownMenuRadioItem>
            ))}
            {authors.length > 0 && (
              <DropdownMenuLabel className="text-muted-foreground/70">
                Author
              </DropdownMenuLabel>
            )}
            {authors.map((a) => (
              <DropdownMenuRadioItem
                key={`author:${a.email}`}
                value={`author:${a.email}`}
              >
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <OptionCount count={a.count} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {hasFilter && (
        <FilterClearButton label="Clear filter" onClick={clearFilter} />
      )}

      <div className="ml-auto shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterChipTrigger
              icon={SwitchVertical01}
              active
              value={POST_SORT_SHORT[sort]}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(v) => onSortChange(v as PostSort)}
            >
              {(Object.keys(POST_SORT_LABELS) as PostSort[]).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {POST_SORT_LABELS[value]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Small "×" that clears an active filter chip. */
function FilterClearButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
    >
      <X size={12} />
    </button>
  );
}

/** Tooltip-wrapped "select all" checkbox shared by the filter bar + toolbar. */
function SelectAllControl({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex shrink-0 items-center px-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={checked}
            disabled={disabled}
            onCheckedChange={() => onToggle()}
            aria-label={checked ? "Deselect all posts" : "Select all posts"}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {checked ? "Deselect all" : "Select all"}
      </TooltipContent>
    </Tooltip>
  );
}

export function PostSelectionToolbar({
  count,
  allSelected,
  onToggleSelectAll,
  onDelete,
  onExit,
}: {
  count: number;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  onDelete: () => void;
  onExit: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5 border-b bg-accent/40 px-2 py-1.5">
      <SelectAllControl checked={allSelected} onToggle={onToggleSelectAll} />
      <span className="text-xs font-medium tabular-nums">{count} selected</span>
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              disabled={count === 0}
              onClick={onDelete}
              aria-label="Delete selected posts"
            >
              <Trash01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Delete selected</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onExit}
              aria-label="Exit selection"
            >
              <X size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Exit selection</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
