import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * One row of the Content tab's sidebar: an icon, the collection's name and
 * how many it holds. Both sidebars use it: v7's fixed collections and a v8
 * site's content types.
 */
export function CollectionRow({
  icon: Icon,
  label,
  count,
  mark,
  active,
  onClick,
  indent,
  "aria-current": ariaCurrent,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  count?: number;
  /** Before the count: a status mark, such as the "has changes" dot. */
  mark?: ReactNode;
  active: boolean;
  onClick: () => void;
  indent?: boolean;
  "aria-current"?: "page";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={ariaCurrent}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors cursor-pointer",
        indent && "pl-6",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {mark}
      {count !== undefined && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            active ? "text-accent-foreground/70" : "text-muted-foreground/70",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** A heading over a group of sidebar rows (Blog; Collections, Singletons). */
export function CollectionGroupLabel({
  icon: Icon,
  label,
}: {
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  return (
    <div className="mt-3 flex items-center gap-1.5 px-2.5 pb-1 pt-1 text-xs font-medium text-muted-foreground/70">
      {Icon && <Icon size={13} className="shrink-0" />}
      {label}
    </div>
  );
}
