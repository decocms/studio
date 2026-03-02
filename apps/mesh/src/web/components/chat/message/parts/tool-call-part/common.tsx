"use client";

import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronRight, Check, Copy01 } from "@untitledui/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import { useAutoScroll } from "@deco/ui/hooks/use-auto-scroll.ts";
import { useCopy } from "@deco/ui/hooks/use-copy.ts";
import { MessageUsageStats } from "../../../usage-stats.tsx";
import type { UsageStats as UsageStatsType } from "@/web/lib/usage-utils.ts";

export interface ToolCallShellProps {
  /** Icon rendered at the left of the row (ReactNode — caller picks the icon) */
  icon: ReactNode;
  /** Primary label (tool name, question text, agent title) */
  title: string;
  /** Usage stats for the operation (optional) */
  usage?: UsageStatsType | null;
  /** Latency in seconds for the operation (optional) */
  latency?: number;
  /** Short status text shown inline after the label */
  summary?: string;
  /** Derived UI state computed by caller based on their loading semantics */
  state: "loading" | "error" | "idle" | "approval";
  /** Detail shown in expanded view */
  detail?: string | null;
  /** How to render the detail panel. "code" = monospace pre with left rail, "prose" = plain text with muted bg */
  detailVariant?: "code" | "prose";
  /** When true, forces the detail panel open (e.g. while streaming thinking). Prevents user closing. */
  forceOpen?: boolean;
  /** Optional actions rendered in the approval card footer */
  actions?: ReactNode;
  /** Visual variant — "subtask" gets indented with a left rail */
  variant?: "default" | "subtask";
  /** Optional icons/badges rendered at the right end of the row (before usage stats) */
  trailing?: ReactNode;
  /** When true, renders the icon in destructive color regardless of state */
  iconDestructive?: boolean;
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
  actions,
  variant = "default",
  trailing,
  iconDestructive,
}: ToolCallShellProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { handleCopy, copied } = useCopy();
  const isLoading = state === "loading";
  const isError = state === "error";
  const isApproval = state === "approval";
  const isExpandable = !!(detail && detail.trim());
  const isSubtask = variant === "subtask";
  const effectiveOpen = (forceOpen ?? false) || isExpanded;

  const detailScrollRef = useRef<HTMLDivElement>(null);
  const { sentinelRef } = useAutoScroll({
    containerRef: detailScrollRef,
    enabled: isLoading && effectiveOpen,
    contentDeps: [detail],
  });

  // ── Approval: explicit bordered card ──────────────────────────────────────
  if (isApproval) {
    return (
      <div className="rounded-md border border-border/60 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <div className="shrink-0 flex items-center [&>svg]:size-4 [&>svg]:text-muted-foreground/75">
            {icon}
          </div>
          <span className="flex-1 min-w-0 text-[14px] font-normal text-foreground truncate">
            {title}
          </span>
          {summary && (
            <span className="shrink-0 text-xs text-muted-foreground/50 truncate max-w-[50%]">
              {summary}
            </span>
          )}
        </div>
        {actions && (
          <div className="flex items-center px-3 py-2 border-t border-border/50">
            {actions}
          </div>
        )}
      </div>
    );
  }

  // ── Log row: no border, no background ─────────────────────────────────────
  const logRow = (
    <Collapsible
      open={effectiveOpen}
      onOpenChange={forceOpen ? undefined : setIsExpanded}
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
        {/* Icon slot: tool icon by default, morphs into chevron on hover/expand */}
        <div className="relative shrink-0 size-4 flex items-center justify-center">
          {/* Tool icon — hidden on hover (expandable) or when expanded */}
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center [&>svg]:size-4 transition-opacity duration-150",
              iconDestructive || isError
                ? "[&>svg]:text-destructive/70"
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
        </div>

        {/* Label */}
        <span
          className={cn(
            "shrink-0 text-[14px] font-normal",
            isError ? "text-destructive/70" : "text-foreground",
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
          {detailVariant === "prose" ? (
            <div className="mt-1 mb-1">
              <div
                ref={detailScrollRef}
                className="max-h-[150px] overflow-y-auto rounded-md bg-muted/30 px-3 py-2"
              >
                <p className="text-xs text-muted-foreground/70 whitespace-pre-wrap leading-relaxed wrap-break-word">
                  {detail}
                </p>
                <div ref={sentinelRef} className="h-0 shrink-0" />
              </div>
            </div>
          ) : (
            <div className="ml-[20px] pl-3 border-l border-border/30 mt-0.5 pb-1">
              <div
                ref={detailScrollRef}
                className="flex flex-col max-h-48 overflow-y-auto"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <pre className="text-xs font-mono text-muted-foreground/70 whitespace-pre-wrap wrap-break-word">
                      {detail}
                    </pre>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(detail!)}
                    className="shrink-0 p-1.5 rounded-md text-muted-foreground/50 [@media(hover:hover)]:hover:text-foreground [@media(hover:hover)]:hover:bg-accent/50 transition-colors active:scale-[0.97]"
                    aria-label="Copy"
                  >
                    {copied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy01 className="size-3.5" />
                    )}
                  </button>
                </div>
                <div ref={sentinelRef} className="h-0 shrink-0" />
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
