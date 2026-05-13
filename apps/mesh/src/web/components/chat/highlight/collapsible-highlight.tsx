/**
 * CollapsibleHighlight — the shared shell for every banner in the chat
 * highlight slot (todos, question, plan, approval, error, warning).
 *
 * One always-visible chip row (icon + label + optional count + caret),
 * one expandable body containing the substantive content (form fields,
 * plan markdown, todo list, etc.), and an optional footer row.
 *
 * Open/close state is local. Each banner instance gets its own state;
 * the parent passes a stable `key` so React remounts on identity change
 * (a new question, a new approval batch, a new plan) and the new instance
 * starts at `defaultExpanded`. Stable identity = stable state across
 * re-renders.
 *
 * The body is rendered into the DOM unconditionally and hidden via the
 * `hidden` attribute when collapsed. This preserves form state, scroll
 * position, and selected tab across collapse/expand cycles.
 */

import { useState, type ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronDown, ChevronUp } from "@untitledui/icons";

export type HighlightVariant = "default" | "error" | "warning";

export interface CollapsibleHighlightProps {
  /** Small icon shown at the left of the chip row (~14px). */
  icon: ReactNode;
  /** One short phrase summarizing the banner, e.g. "Question pending". */
  label: string;
  /** Optional right-aligned count, e.g. "1 of 3" or "3 pending". */
  count?: string | null;
  /** Heading shown inside the expanded body. */
  title?: string | null;
  /** Footer-left content (e.g. <Pagination />). */
  footerLeft?: ReactNode;
  /** Footer-right content (action buttons). */
  footerRight?: ReactNode;
  /** Body content. */
  children?: ReactNode;
  /** Initial open state on first mount. */
  defaultExpanded: boolean;
  /** Drives translucent overlay for status banners. */
  variant?: HighlightVariant;
}

const VARIANT_OVERLAY: Record<HighlightVariant, string> = {
  default: "",
  error: "bg-destructive/5",
  warning: "bg-amber-500/5",
};

const VARIANT_BORDER: Record<HighlightVariant, string> = {
  default: "border-border",
  error: "border-destructive/30",
  warning: "border-amber-500/30",
};

const VARIANT_ICON_COLOR: Record<HighlightVariant, string> = {
  default: "text-muted-foreground",
  error: "text-destructive",
  warning: "text-amber-600 dark:text-amber-500",
};

export function CollapsibleHighlight({
  icon,
  label,
  count,
  title,
  footerLeft,
  footerRight,
  children,
  defaultExpanded,
  variant = "default",
}: CollapsibleHighlightProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      data-testid="collapsible-highlight"
      data-variant={variant}
      className={cn(
        "flex flex-col rounded-xl bg-background border shadow-md",
        "w-[calc(100%-16px)] max-w-[584px] mx-auto mb-2",
        VARIANT_BORDER[variant],
        VARIANT_OVERLAY[variant],
      )}
    >
      <button
        type="button"
        data-testid="collapsible-highlight-chip"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className={cn(
          "flex items-center gap-2 w-full px-3 py-2 text-sm text-left",
          "hover:bg-accent/50 transition-colors rounded-t-xl",
          expanded && "rounded-b-none",
          !expanded && "rounded-b-xl",
        )}
      >
        <span className={cn("shrink-0", VARIANT_ICON_COLOR[variant])}>
          {icon}
        </span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        {count ? (
          <span className="text-xs text-muted-foreground shrink-0">
            {count}
          </span>
        ) : null}
        <span aria-hidden="true" className="text-muted-foreground shrink-0">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      <div hidden={!expanded} data-testid="collapsible-highlight-body">
        {title ? (
          <div className="flex items-center gap-2 px-4 pt-3 pb-1 border-t border-dashed border-border/60">
            <p className="flex-1 text-base font-medium text-foreground min-w-0">
              {title}
            </p>
          </div>
        ) : (
          <div className="border-t border-dashed border-border/60" />
        )}

        {children ? (
          <div className="overflow-clip pb-4 pt-2">{children}</div>
        ) : null}

        {footerLeft || footerRight ? (
          <div className="border-t border-border px-3 py-3 pb-6">
            <div className="flex items-center justify-between">
              <div>{footerLeft}</div>
              <div className="flex items-center gap-2">{footerRight}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
