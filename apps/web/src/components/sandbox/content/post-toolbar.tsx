import { forwardRef } from "react";
import {
  ChevronDown,
  FilterFunnel01,
  SwitchVertical01,
  Trash01,
  X,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { PostSort } from "./content-browser";

// Sentinel for the "no filter" radio option (Radix forbids empty values).
const ALL_FILTER = "__all__";

// ponytail: sort labels keyed by PostSort type for runtime translation
const POST_SORT_LABELS_KEYS: Record<PostSort, TranslationKey> = {
  "date-desc": "sandbox.postToolbar.sortNewestFirst",
  "date-asc": "sandbox.postToolbar.sortOldestFirst",
  az: "sandbox.postToolbar.sortTitleAZ",
  za: "sandbox.postToolbar.sortTitleZA",
};

const POST_SORT_SHORT_KEYS: Record<PostSort, TranslationKey> = {
  "date-desc": "sandbox.postToolbar.sortNewest",
  "date-asc": "sandbox.postToolbar.sortOldest",
  az: "sandbox.postToolbar.sortAZ",
  za: "sandbox.postToolbar.sortZA",
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
  const t = useT();
  const activeCategory = categories.find((c) => c.slug === categoryFilter);
  const activeAuthor = authors.find((a) => a.email === authorFilter);
  const hasFilter = !!(categoryFilter || authorFilter);
  const activeLabel =
    activeCategory?.name ??
    activeAuthor?.name ??
    t("sandbox.postToolbar.filterLabel");
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
          <DropdownMenuLabel>
            {t("sandbox.postToolbar.filterBy")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activeValue}
            onValueChange={handleFilterChange}
          >
            <DropdownMenuRadioItem value={ALL_FILTER}>
              {t("sandbox.postToolbar.allPosts")}
            </DropdownMenuRadioItem>
            {categories.length > 0 && (
              <DropdownMenuLabel className="text-muted-foreground/70">
                {t("sandbox.postToolbar.categoryLabel")}
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
                {t("sandbox.postToolbar.authorLabel")}
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
        <FilterClearButton
          label={t("sandbox.postToolbar.clearFilter")}
          onClick={clearFilter}
        />
      )}

      <div className="ml-auto shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterChipTrigger
              icon={SwitchVertical01}
              active
              value={t(POST_SORT_SHORT_KEYS[sort])}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>
              {t("sandbox.postToolbar.sortBy")}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(v) => onSortChange(v as PostSort)}
            >
              {(Object.keys(POST_SORT_LABELS_KEYS) as PostSort[]).map(
                (value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {t(POST_SORT_LABELS_KEYS[value])}
                  </DropdownMenuRadioItem>
                ),
              )}
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
  const t = useT();
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
            aria-label={
              checked
                ? t("sandbox.postToolbar.deselectAllPosts")
                : t("sandbox.postToolbar.selectAllPosts")
            }
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {checked
          ? t("sandbox.postToolbar.deselectAll")
          : t("sandbox.postToolbar.selectAll")}
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
  const t = useT();
  return (
    <div className="flex items-center gap-0.5 border-b bg-accent/40 px-2 py-1.5">
      <SelectAllControl checked={allSelected} onToggle={onToggleSelectAll} />
      <span className="text-xs font-medium tabular-nums">
        {t("sandbox.postToolbar.itemsSelected", { count })}
      </span>
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
              aria-label={t("sandbox.postToolbar.deleteSelectedPosts")}
            >
              <Trash01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("sandbox.postToolbar.deleteSelected")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onExit}
              aria-label={t("sandbox.postToolbar.exitSelection")}
            >
              <X size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("sandbox.postToolbar.exitSelection")}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
