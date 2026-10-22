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
    <section className="@container flex flex-col overflow-hidden surface">
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
      className={cn("px-5 py-3.5 transition-colors hover:bg-accent", className)}
    >
      {children}
    </li>
  );
}
