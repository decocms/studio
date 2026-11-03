/**
 * Small cards that open in place: the open one takes the whole row and shows
 * its detail, and opening another closes it. The summary is the button and
 * the detail sits beside it, so the links and actions inside it work.
 */

import { type ReactNode, useId, useState } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

export interface ExpandableItem {
  id: string;
  summary: (open: boolean) => ReactNode;
  /** What the open card adds below its summary; null for nothing. */
  detail: ReactNode | null;
  /** Whether the card opens; by default, when it has a detail. A card may open only to show its summary whole. */
  opens?: boolean;
  /** Shown as chosen, such as the briefing a campaign was developed from. */
  selected?: boolean;
  /** A card with nothing to say, drawn quieter. */
  muted?: boolean;
}

export function ExpandableGrid({
  items,
  columns = 2,
}: {
  items: readonly ExpandableItem[];
  columns?: 2 | 3;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const baseId = useId();

  return (
    <div
      className={cn(
        "grid gap-[9px]",
        columns === 3 ? "md:grid-cols-3" : "sm:grid-cols-2",
      )}
    >
      {items.map((item) => {
        const opens = item.opens ?? item.detail !== null;
        const expanded = open === item.id && opens;
        const detailId = `${baseId}-${item.id}`;
        return (
          <div
            key={item.id}
            className={cn(
              "rounded-[11px] border",
              item.selected ? "border-primary" : "border-border",
              item.muted ? "bg-transparent" : "bg-card",
              expanded && "col-span-full shadow-sm",
            )}
          >
            {!opens ? (
              <div className="px-[13px] py-3">{item.summary(false)}</div>
            ) : (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={item.detail === null ? undefined : detailId}
                onClick={() => setOpen(expanded ? null : item.id)}
                className="block w-full rounded-[11px] px-[13px] py-3 text-left transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {item.summary(expanded)}
              </button>
            )}
            {expanded && item.detail !== null && (
              <div
                id={detailId}
                className="mx-[13px] border-t border-border pt-3 pb-[13px]"
              >
                {item.detail}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
