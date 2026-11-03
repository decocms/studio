/**
 * Small cards that open in place: the open one takes the whole row and shows
 * its detail, and opening another closes it. The summary is the button and
 * the detail sits beside it, so the links and actions inside it work.
 */

import { type ReactNode, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "@decocms/ui/lib/utils.ts";

/** The dialog's timing, so a card opens the way a goal does. */
const DURATION = 300;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** The cards' corner, kept while a growing card is uncovered. */
const RADIUS = "11px";

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

/**
 * Applies `change` as motion: each card starts where it was drawn and slides
 * to its new place, a card that grew is uncovered from its old size, and the
 * grid's height follows, so what sits below it glides instead of jumping.
 */
function moveCards(grid: HTMLElement, change: () => void) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    change();
    return;
  }
  const cards = [...grid.children].filter(
    (card) => card instanceof HTMLElement,
  );
  const before = new Map(
    cards.map((card) => [card, card.getBoundingClientRect()]),
  );
  const height = grid.getBoundingClientRect().height;
  // Measured first, so a click mid-move starts from where the cards are drawn.
  for (const element of [grid, ...cards]) {
    for (const animation of element.getAnimations()) animation.cancel();
  }
  flushSync(change);

  const timing = { duration: DURATION, easing: EASE };
  grid.animate(
    [
      { height: `${height}px` },
      { height: `${grid.getBoundingClientRect().height}px` },
    ],
    timing,
  );
  for (const card of cards) {
    const from = before.get(card);
    if (!from || !card.isConnected) continue;
    const to = card.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const right = Math.max(0, to.width - from.width);
    const bottom = Math.max(0, to.height - from.height);
    if (Math.abs(dx) + Math.abs(dy) + right + bottom < 1) continue;
    card.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px)`,
          clipPath: `inset(0px ${right}px ${bottom}px 0px round ${RADIUS})`,
        },
        {
          transform: "none",
          clipPath: `inset(0px 0px 0px 0px round ${RADIUS})`,
        },
      ],
      timing,
    );
  }
}

export function ExpandableGrid({
  items,
  columns = 2,
}: {
  items: readonly ExpandableItem[];
  columns?: 1 | 2 | 3;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const baseId = useId();
  const gridRef = useRef<HTMLDivElement>(null);

  const toggle = (id: string | null) => {
    const grid = gridRef.current;
    if (grid) moveCards(grid, () => setOpen(id));
    else setOpen(id);
  };

  return (
    <div
      ref={gridRef}
      className={cn(
        // Rows stay at the top while the grid's height is still catching up.
        "grid content-start gap-[9px]",
        columns === 3 && "md:grid-cols-3",
        columns === 2 && "sm:grid-cols-2",
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
                onClick={() => toggle(expanded ? null : item.id)}
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
