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
import { ToolAnnotationBadges } from "@/web/components/tools";
import type { ToolDefinition } from "@decocms/mesh-sdk";

export interface ToolCallShellProps {
  /** Icon rendered at the left of the row (ReactNode — caller picks the icon) */
  icon: ReactNode;
  /** Primary label (tool name, question text, agent title) */
  title: string;
  /** Optional tool annotations to render as badges */
  annotations?: ToolDefinition["annotations"];
  /** Usage stats for the operation (optional) */
  usage?: UsageStatsType | null;
  /** Latency in seconds for the operation (optional) */
  latency?: number;
  /** Second-line summary text shown in collapsed state */
  summary?: string;
  /** Derived UI state computed by caller based on their loading semantics */
  state: "loading" | "error" | "idle";
  /** Detail shown in expanded view. Rendered as plain text (copiable). */
  detail?: string | null;
  /** Optional actions rendered below the title/summary (e.g., approve/deny buttons) */
  actions?: ReactNode;
}

export function ToolCallShell({
  icon,
  title,
  annotations,
  usage,
  latency,
  summary,
  state,
  detail,
  actions,
}: ToolCallShellProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { handleCopy, copied } = useCopy();
  const isLoading = state === "loading";
  const isError = state === "error";
  const isExpandable = !!(detail && detail.trim());

  const detailScrollRef = useRef<HTMLDivElement>(null);
  const { sentinelRef } = useAutoScroll({
    containerRef: detailScrollRef,
    enabled: isLoading && isExpanded,
    contentDeps: [detail],
  });

  return (
    <div className="flex flex-col w-full min-w-0">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="border border-border/75 rounded-lg flex flex-col bg-background w-full min-w-0 overflow-hidden">
          <CollapsibleTrigger
            disabled={!isExpandable}
            className={cn(
              "flex flex-col gap-0.5 w-full p-3 transition-colors text-left",
              isExpandable && "cursor-pointer hover:bg-accent/50",
              !isExpandable && "cursor-default pointer-events-none",
              isLoading && "shimmer",
            )}
            aria-disabled={!isExpandable}
          >
            {/* First line: icon, title, metrics, chevron */}
            <div className="flex items-center gap-2 w-full min-w-0">
              <div
                className={cn(
                  "shrink-0 flex items-center [&>svg]:size-4",
                  isError && "[&>svg]:text-destructive",
                )}
              >
                {icon}
              </div>
              <span
                className={cn(
                  "flex-1 min-w-0 text-[15px] text-muted-foreground truncate",
                  isError && "text-destructive/90",
                )}
              >
                {title}
              </span>
              {latency && (
                <span className="shrink-0 text-xs text-muted-foreground/75 tabular-nums">
                  {latency.toFixed(2)}s
                </span>
              )}
              <MessageUsageStats usage={usage} />
              {annotations && (
                <ToolAnnotationBadges annotations={annotations} />
              )}
              {isExpandable && (
                <ChevronRight
                  className={cn(
                    "size-4 text-muted-foreground shrink-0 transition-transform duration-200",
                    isExpanded && "rotate-90",
                  )}
                />
              )}
            </div>
            {/* Second line: summary */}
            {summary && (
              <div className="flex items-center min-w-0 mt-0.5">
                <span className="flex-1 min-w-0 text-xs text-muted-foreground/75 truncate">
                  {summary}
                </span>
              </div>
            )}
          </CollapsibleTrigger>

          {/* Actions (e.g., approve/deny buttons) - outside shimmer */}
          {actions && (
            <div className="flex flex-1 justify-end px-3 py-3 border-t border-border/50">
              {actions}
            </div>
          )}

          {isExpandable && (
            <CollapsibleContent className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden">
              <div className="border-t border-border/50 px-3 pb-3 pt-3">
                <div
                  ref={detailScrollRef}
                  className="flex flex-col max-h-48 overflow-y-auto"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap wrap-break-word">
                        {detail}
                      </pre>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(detail!)}
                      className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                      aria-label="Copy"
                    >
                      {copied ? (
                        <Check className="size-4" />
                      ) : (
                        <Copy01 className="size-4" />
                      )}
                    </button>
                  </div>
                  <div ref={sentinelRef} className="h-0 shrink-0" />
                </div>
              </div>
            </CollapsibleContent>
          )}
        </div>
      </Collapsible>
    </div>
  );
}

export type { ToolCallMetrics } from "./utils.tsx";
