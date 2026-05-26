import type { Release } from "@/web/lib/release-feed";
import { ChevronRight } from "@untitledui/icons";

export interface InboxReleaseItemProps {
  release: Release;
  isSeen: boolean;
  onSelect: () => void;
}

export function InboxReleaseItem({
  release,
  isSeen,
  onSelect,
}: InboxReleaseItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="relative w-full flex items-center gap-3 px-5 py-4 border-b border-border last:border-0 hover:bg-muted/25 transition-colors text-left"
    >
      {!isSeen && (
        <span
          aria-label="New release"
          className="absolute left-2 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-primary"
        />
      )}
      <div className="flex-1 min-w-0">
        {release.eyebrow && (
          <p className="text-xs text-muted-foreground">{release.eyebrow}</p>
        )}
        <p className="text-sm font-medium text-foreground truncate">
          {release.title}
        </p>
      </div>
      <ChevronRight
        size={16}
        className="text-muted-foreground shrink-0"
      />
    </button>
  );
}
