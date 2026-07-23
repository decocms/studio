import { Loading01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";

interface ShowMoreButtonProps {
  onClick: () => void;
  isFetching: boolean;
  /** When true (inside a sidebar group with `pl-4`), the button stretches its
   *  hover surface out to the group's left edge (-ml-4 cancels the wrapper's
   *  pl-4) while pl-6 keeps the content indented — matching the indented
   *  TaskRow treatment so the clickable surface spans the full sidebar width. */
  indented?: boolean;
}

/**
 * Presentational "Show more" button. Rendered only when the parent
 * determines there are more pages to fetch (`hasMore || isFetching`).
 * Wire it to a paginator via `useGroupShowMore`.
 */
export function ShowMoreButton({
  onClick,
  isFetching,
  indented,
}: ShowMoreButtonProps) {
  const t = useT();
  return (
    <button
      type="button"
      aria-label={t("sidebar.showMoreButton.ariaLabel")}
      onClick={onClick}
      disabled={isFetching}
      className={cn(
        "flex items-center gap-2 py-1.5 rounded-md text-sm text-muted-foreground",
        indented ? "-ml-4 pl-6 pr-2" : "px-2",
        "hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "transition-colors disabled:cursor-progress disabled:opacity-60",
      )}
    >
      {isFetching && <Loading01 size={14} className="animate-spin" />}
      <span>
        {isFetching
          ? t("sidebar.showMoreButton.loading")
          : t("sidebar.showMoreButton.showMore")}
      </span>
    </button>
  );
}
