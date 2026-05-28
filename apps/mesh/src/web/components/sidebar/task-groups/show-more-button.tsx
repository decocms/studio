import { ChevronDown, Loading01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

interface ShowMoreButtonProps {
  onClick: () => void;
  isFetching: boolean;
}

/**
 * Presentational "Show more" button. The caller is responsible for deciding
 * whether to render this at all (i.e. whether `hasMore` is true) and for
 * wiring it to a paginator (see `useGroupShowMore`).
 */
export function ShowMoreButton({ onClick, isFetching }: ShowMoreButtonProps) {
  return (
    <button
      type="button"
      aria-label="Show more tasks"
      onClick={onClick}
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
