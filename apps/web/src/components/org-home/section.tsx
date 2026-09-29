/** The home's furniture: a titled card, and the two-column frame it sits in.
 *  One component rather than five that drift. */

import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/** One block of the home. The header is inside the card, on the same hairline
 *  the rows use, so the block reads as one surface. */
export function HomeCard({
  label,
  count,
  action,
  children,
}: {
  label: string;
  count?: number;
  /** The block's own control, right-aligned in the header. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="@container flex flex-col overflow-hidden rounded-2xl bg-card card-shadow">
      <div className="flex h-12 items-center justify-between gap-3 border-b border-border/70 px-5">
        <h2 className="flex items-baseline gap-2 text-[0.9rem] font-medium tracking-tight text-foreground">
          {label}
          {count !== undefined && count > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </h2>
        {action}
      </div>
      <ul className="flex flex-col divide-y divide-border/70">{children}</ul>
    </section>
  );
}

/** A row inside a {@link HomeCard}. Padded, not bordered — the list owns the
 *  rules. */
export function HomeCardRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <li
      className={cn(
        "px-5 py-3.5 transition-colors hover:bg-accent/30",
        className,
      )}
    >
      {children}
    </li>
  );
}

/**
 * Work on the left, standing readouts on the right, one column when the panel
 * cannot hold both. 1.35 to 1: the left holds sentences and the right holds
 * numbers, but a 30% rail starves into a void beside the long column.
 */
export function HomeSplit({
  main,
  aside,
}: {
  main: ReactNode;
  aside: ReactNode;
}) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">{main}</div>
        <div className="flex min-w-0 flex-col gap-6">{aside}</div>
      </div>
    </div>
  );
}
