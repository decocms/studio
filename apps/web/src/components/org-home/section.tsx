/**
 * The home's furniture: a titled card, and the two-column frame it sits in.
 *
 * Every block on the home is the same object — a title, a count, one control,
 * and rows divided by hairlines — so it is one component rather than five that
 * drift. The label is deliberately small: a page whose headings out-shout their
 * content makes you read the furniture before the work.
 */

import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * One block of the home: a header strip, then its rows.
 *
 * The header is inside the card and separated by the same hairline the rows
 * use, so the whole block reads as one surface rather than a floating label
 * above a box.
 */
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

/** A row inside a {@link HomeCard}. Padded, not bordered: the list owns the
 *  rules, so a row that draws its own would double them at every join. */
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
 * The home's two-column read: the work on the left, the standing readouts on
 * the right, collapsing to one column when the panel cannot hold both.
 *
 * The mock's `.today-grid`: 1.35 to 1, not 70/30. The left column holds
 * sentences and the right holds numbers, so it gets the extra width — but a
 * right rail starved to 30% left a column of short cards beside a long one,
 * which is the void that made the page read as unfinished.
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
