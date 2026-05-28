import { ChevronDown, Loading01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useGroupShowMore } from "./use-group-show-more";
import type { SidebarFilters, GroupKind } from "./next-page-offset";

interface ShowMoreButtonProps {
  kind: GroupKind;
  groupKey: string;
  filters: SidebarFilters;
}

export function ShowMoreButton({
  kind,
  groupKey,
  filters,
}: ShowMoreButtonProps) {
  const { hasMore, isFetching, loadMore } = useGroupShowMore(
    kind,
    groupKey,
    filters,
  );
  if (!hasMore) return null;
  return (
    <button
      type="button"
      aria-label="Show more tasks"
      onClick={() => void loadMore()}
      disabled={isFetching}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground",
        "hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "transition-colors disabled:cursor-progress disabled:opacity-60",
      )}
    >
      {isFetching ? (
        <Loading01 size={14} className="animate-spin" />
      ) : (
        <ChevronDown size={14} />
      )}
      <span>{isFetching ? "Loading…" : "Show more"}</span>
    </button>
  );
}
