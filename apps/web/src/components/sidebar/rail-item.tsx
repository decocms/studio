/**
 * One mark on the org rail: a glyph, and the word for it underneath, so the
 * rail is navigation you can read rather than positions you memorise.
 *
 * Two lines, clamped — a third would make one mark twice its neighbours'
 * height, and the tooltip still carries the full name.
 */

import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * The rail's selection signal: a pill in the left gutter, which works the same
 * against a square org logo and a tinted app glyph.
 *
 * It centres on the GLYPH, not the item — with a label underneath, centring on
 * the item lands the pill beside the text.
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
