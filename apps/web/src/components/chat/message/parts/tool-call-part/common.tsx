"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowRight, ChevronRight, Check, Copy01 } from "@untitledui/icons";
import { formatDuration } from "@/lib/format-time.ts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import { useCopy } from "@deco/ui/hooks/use-copy.ts";
import { useStickToBottom } from "use-stick-to-bottom";
import { MessageUsageStats } from "../../../usage-stats.tsx";
import type { UsageStats as UsageStatsType } from "@/lib/usage-utils.ts";

export interface ToolCallShellProps {
  /** Icon rendered at the left of the row (ReactNode — caller picks the icon) */
  icon: ReactNode;
  /** Primary label (tool name, question text, agent title) */
  title: ReactNode;
  /** Usage stats for the operation (optional) */
  usage?: UsageStatsType | null;
  /** Latency in seconds for the operation (optional) */
  latency?: number;
  /** Short status text (or node, e.g. a live countdown) shown inline after the label */
  summary?: ReactNode;
  /** Derived UI state computed by caller based on their loading semantics */
  state: "loading" | "error" | "idle";
  /** Detail shown in expanded view */
  detail?: string | null;
  /** How to render the detail panel. "code" = monospace pre with left rail, "prose" = plain text with muted bg */
  detailVariant?: "code" | "prose";
  /** When true, forces the detail panel open (e.g. while streaming thinking). Prevents user closing. */
  forceOpen?: boolean;
  /** Visual variant — "subtask" gets indented with a left rail */
  variant?: "default" | "subtask";
  /** Optional icons/badges rendered at the right end of the row (before usage stats) */
  trailing?: ReactNode;
  /** When true, renders the icon in destructive color regardless of state */
  iconDestructive?: boolean;
  /** When true, always shows the chevron in the icon slot (skips the icon/hover morph) */
  alwaysChevron?: boolean;
  /** When true, the collapsible starts expanded (user can still close it) */
  defaultOpen?: boolean;
  /** Custom expandable content — when provided, replaces detail string rendering */
  children?: ReactNode;
}

export function ToolCallShell({
  icon,
  title,
  usage,
  latency: _latency,
  summary,
  state,
  detail,
  detailVariant = "code",
  forceOpen,
  variant = "default",
  trailing,
  iconDestructive,
  alwaysChevron,
  defaultOpen,
  children,
}: ToolCallShellProps) {
  const t = useT();
  const [isExpanded, setIsExpanded] = useState(defaultOpen ?? false);
  const { handleCopy, copied } = useCopy();
  const isLoading = state === "loading";
  const isError = state === "error";
  const hasDetailString = !!(detail && detail.trim());
  const isExpandable = hasDetailString || !!children;
  const isSubtask = variant === "subtask";
  const effectiveOpen = (forceOpen ?? false) || isExpanded;

  // Tool-detail pane auto-follow, independent from the main chat scroller's
  // useStickToBottom instance. The lib exposes no `enabled` flag, so gating
  // relies on mount/unmount instead: CollapsibleContent (Radix) unmounts the
  // pane's DOM entirely when collapsed, which detaches these refs (the lib's
  // scrollRef/contentRef callbacks clean up their listeners/observer on
  // `null`) and reattaches them fresh the next time the pane opens.
  // `initial: isLoading ? "instant" : false`: a pane opened WHILE the tool
  // is still streaming already holds the full accumulated `detail` text on
  // mount (it kept updating while unmounted), so land at the bottom
  // immediately instead of visibly animating down from the top — matches
  // the old `useAutoScroll({ enabled: isLoading && effectiveOpen })`
  // behavior. A pane opened AFTER the tool finished must NOT auto-scroll:
  // `initial: false` leaves it at its natural (top) position instead of
  // snapping a large finished result to the bottom. The pane mounts fresh
  // on every open (CollapsibleContent unmounts on close), so `isLoading` is
  // read at exactly the right moment; a pane already open across the
  // loading→done transition needs no special handling since `initial` only
  // applies to the mount-time scroll.
  const detailStick = useStickToBottom({
    initial: isLoading ? "instant" : false,
  });
  const logRow = (
    <Collapsible
      open={effectiveOpen}
      onOpenChange={forceOpen ? undefined : setIsExpanded}
      className="min-w-0"
    >
      <CollapsibleTrigger
        disabled={!isExpandable}
        className={cn(
          "group/tool flex items-center gap-2 w-full py-2.5 text-left transition-colors",
          isExpandable && "[@media(hover:hover)]:hover:bg-accent/30",
          !isExpandable && "cursor-default",
          isLoading && "shimmer",
        )}
        aria-disabled={!isExpandable}
      >
        {/* Icon slot: chevron only (alwaysChevron), or tool icon that morphs into chevron on hover/expand */}
        <div className="relative shrink-0 size-4 flex items-center justify-center">
          {alwaysChevron ? (
            <ChevronRight
              className={cn(
                "size-4 text-foreground/60 transition-transform duration-200 ease-in-out",
                effectiveOpen && "rotate-90",
              )}
            />
          ) : (
            <>
              {/* Tool icon — hidden on hover (expandable) or when expanded */}
              <div
                className={cn(
                  "absolute inset-0 flex items-center justify-center [&>svg]:size-4 transition-opacity duration-150",
                  iconDestructive
                    ? "[&>svg]:text-destructive/70"
                    : isError
                      ? "[&>svg]:text-warning/70"
                      : "[&>svg]:text-muted-foreground/75",
                  isExpandable &&
                    (effectiveOpen
                      ? "opacity-0"
                      : "[@media(hover:hover)]:group-hover/tool:opacity-0"),
                )}
              >
                {icon}
              </div>
              {/* Chevron — appears on hover or when expanded */}
              {isExpandable && (
                <div
                  className={cn(
                    "absolute inset-0 flex items-center justify-center transition-opacity duration-150",
                    effectiveOpen
                      ? "opacity-100"
                      : "opacity-0 [@media(hover:hover)]:group-hover/tool:opacity-100",
                  )}
                >
                  <ChevronRight
                    className={cn(
                      "size-4 text-foreground/60 transition-transform duration-200 ease-in-out",
                      effectiveOpen && "rotate-90",
                    )}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Label */}
        <span
          className={cn(
            "shrink-0 text-[14px] font-normal",
            isError ? "text-warning/80" : "text-foreground",
          )}
        >
          {title}
        </span>

        {/* Inline summary — pill with subtle bg */}
        {summary ? (
          <span className="min-w-0 flex-1 truncate">
            <span className="text-[12px] text-muted-foreground/60 bg-muted/50 rounded-[3px] px-1 py-px leading-none">
              {summary}
            </span>
          </span>
        ) : (
          <div className="flex-1" />
        )}

        {trailing && (
          <div className="shrink-0 flex items-center gap-1 [&_svg]:size-3.5 [&_svg]:text-muted-foreground/50">
            {trailing}
          </div>
        )}
        <MessageUsageStats usage={usage} />
      </CollapsibleTrigger>

      {/* Expanded detail */}
      {isExpandable && (
        <CollapsibleContent className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden">
          {children ? (
            children
          ) : detailVariant === "prose" ? (
            <div className="mt-1 mb-1">
              <div
                ref={detailStick.scrollRef}
                className="max-h-[150px] overflow-y-auto rounded-md bg-muted/30 px-3 py-2"
              >
                <p
                  ref={detailStick.contentRef}
                  className="text-xs text-muted-foreground/70 whitespace-pre-wrap leading-relaxed wrap-break-word"
                >
                  {detail}
                </p>
              </div>
            </div>
          ) : (
            <div className="ml-[20px] pl-3 border-l border-border/30 mt-0.5 pb-1">
              <div
                ref={detailStick.scrollRef}
                className="flex flex-col max-h-48 overflow-y-auto"
              >
                <div
                  ref={detailStick.contentRef}
                  className="flex items-start justify-between gap-2"
                >
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <pre className="text-xs font-mono text-muted-foreground/70 whitespace-pre-wrap wrap-break-word">
                      {detail}
                    </pre>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(detail!)}
                    className="shrink-0 p-1.5 rounded-md text-muted-foreground/50 [@media(hover:hover)]:hover:text-foreground [@media(hover:hover)]:hover:bg-accent/50 transition-colors active:scale-[0.97]"
                    aria-label={t("common.copy")}
                  >
                    {copied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy01 className="size-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </CollapsibleContent>
      )}
    </Collapsible>
  );

  // Subtask: indent with left rail
  if (isSubtask) {
    return (
      <div className="pl-4 border-l border-border/40 ml-1.5">{logRow}</div>
    );
  }

  return logRow;
}

export type { ToolCallMetrics } from "./utils.tsx";

/** Renders a latency badge for the `trailing` slot of ToolCallShell. */
export function LatencyLabel({ latency }: { latency?: number }) {
  if (latency == null || latency <= 0) return null;
  return (
    <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
      {formatDuration(latency)}
    </span>
  );
}

/** Max items shown before a "See all" row in list-style tool cards. */
export const MAX_VISIBLE = 4;

/** "See all N <noun>" footer row used by list-style tool cards. */
export function SeeAllRow({
  count,
  noun,
  onClick,
}: {
  count: number;
  noun: string;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
    >
      {t("common.seeAll", { count, noun })}
      <ArrowRight
        className="size-4 transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </button>
  );
}
