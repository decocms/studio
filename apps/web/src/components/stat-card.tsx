import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/** A metric card, shared by every stats strip; the label strip is a fixed
 *  height so cards in a row read off one baseline. `interactive` overlays an invisible `<button>` rather than
 *  making the `<section>` one, because `action` is itself a button and buttons
 *  cannot nest. */
export const StatCard = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    action?: ReactNode;
    className?: string;
    children: ReactNode;
    interactive?: boolean;
  } & ButtonHTMLAttributes<HTMLButtonElement>
>(function StatCard(
  { label, action, className, children, interactive, ...buttonProps },
  ref,
) {
  return (
    <section
      className={cn(
        "surface @container relative flex min-w-0 flex-col gap-3 p-5 text-left",
        interactive && "transition-colors hover:bg-accent/30",
        className,
      )}
    >
      {interactive && (
        <button
          type="button"
          ref={ref}
          aria-label={label}
          className="absolute inset-0 z-0 cursor-pointer rounded-m"
          {...buttonProps}
        />
      )}
      <div
        className={cn(
          "flex h-5 items-center justify-between gap-3",
          interactive && "pointer-events-none",
        )}
      >
        <h3 className="truncate text-sm text-muted-foreground">{label}</h3>
        {action && (
          <div
            className={cn(interactive && "relative z-10 pointer-events-auto")}
          >
            {action}
          </div>
        )}
      </div>
      {interactive ? (
        <div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-2">
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
});

/** The headline figure; one size for every stat card. */
export function Figure({
  value,
  caption,
}: {
  value: string;
  caption?: ReactNode;
}) {
  return (
    <p className="flex items-baseline gap-2.5">
      <span className="tnum text-xl font-semibold text-foreground leading-none">
        {value}
      </span>
      {caption && (
        <span className="min-w-0 truncate text-muted-foreground text-xs">
          {caption}
        </span>
      )}
    </p>
  );
}
