import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * A button in a block's floating toolbar. Shared by the blog block editors
 * and the responsive image field, which sit in different trees but render the
 * same bar.
 */
export function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // Keep the surrounding editor's selection while clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 min-w-7 items-center justify-center px-1.5 text-sm transition-colors cursor-pointer rounded-[var(--studio-control-radius,var(--radius))]",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Group separator inside a toolbar. */
export function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />;
}
