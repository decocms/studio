/**
 * One mark on the org rail: a glyph, and the word for it underneath.
 *
 * The label is the whole point. A column of tinted squares is a memory test —
 * you learn it by position, which means you learn it by clicking the wrong one
 * first, and a tooltip only pays out after you have already aimed at something.
 * Naming each mark turns the rail from a set of shortcuts you have memorised
 * into navigation you can read, which is the trade Slack makes in the same
 * column and the reason theirs is usable on the first day.
 *
 * Two lines, clamped. A name longer than that is rare, the tooltip still has
 * the full one, and letting the third line through would make one mark twice
 * the height of its neighbours.
 */

import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * The rail's one selection signal, shared by orgs and apps.
 *
 * A pill on the rail's left edge rather than a ring around the mark: a ring
 * has to sit OUTSIDE the icon, so it competes with the icon's own shape and
 * needs an offset colour that only works against one background. The pill
 * lives in the gutter, is the same for a square org logo and a tinted app
 * glyph, and can grow out of its hover state instead of appearing from
 * nowhere.
 *
 * It centres on the GLYPH, not on the item. With a label under it the item is
 * half again as tall, and a pill centred on that lands beside the text rather
 * than beside the thing it is marking.
 */
export function RailItem({
  active,
  label,
  children,
}: {
  active: boolean;
  /** Omit for a mark that already says its own name (a tooltip still can). */
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="group/rail relative flex w-full shrink-0 flex-col items-center gap-1">
      <span aria-hidden className="absolute top-0 left-0 flex h-9 items-center">
        <span
          className={cn(
            "w-1 rounded-r-full bg-foreground",
            "transition-[height,opacity] duration-200 ease-[var(--ease-out-cubic)]",
            "motion-reduce:transition-none",
            active
              ? "h-7 opacity-100"
              : "h-2 opacity-0 group-hover/rail:opacity-60",
          )}
        />
      </span>
      {children}
      {/* `aria-hidden`: every trigger this wraps already carries the same text
          as its accessible name, so announcing it twice is noise. */}
      {label && (
        <span
          aria-hidden
          className={cn(
            "line-clamp-2 w-full px-1 text-center text-2xs break-words transition-colors",
            active
              ? "font-medium text-sidebar-foreground"
              : "text-muted-foreground group-hover/rail:text-sidebar-foreground",
          )}
        >
          {label}
        </span>
      )}
    </div>
  );
}
