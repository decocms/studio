import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowLeft, ArrowRight, ChevronDown } from "@untitledui/icons";
import { useState } from "react";

// ease-in-out-cubic — on-screen morph per animation guide
const EASE = "cubic-bezier(0.645, 0.045, 0.355, 1)";

// ============================================================================
// Pagination - "← 1 of 4 →" control
// ============================================================================

export interface PaginationProps {
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function Pagination({
  current,
  total,
  onPrev,
  onNext,
}: PaginationProps) {
  if (total <= 1) return null;
  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground">
      <button
        type="button"
        onClick={onPrev}
        disabled={current === 0}
        className={cn(
          "p-0.5 rounded transition-colors",
          current === 0
            ? "opacity-30 cursor-not-allowed"
            : "hover:text-foreground cursor-pointer",
        )}
        aria-label="Previous question"
      >
        <ArrowLeft size={14} />
      </button>
      <span className="tabular-nums text-xs">
        {current + 1} of {total}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={current === total - 1}
        className={cn(
          "p-0.5 rounded transition-colors",
          current === total - 1
            ? "opacity-30 cursor-not-allowed"
            : "hover:text-foreground cursor-pointer",
        )}
        aria-label="Next question"
      >
        <ArrowRight size={14} />
      </button>
    </div>
  );
}

// ============================================================================
// HighlightCard - the card chrome wrapping highlight content
// ============================================================================

export interface HighlightCardProps {
  title: string;
  children: React.ReactNode;
  footerLeft?: React.ReactNode;
  footerRight: React.ReactNode;
  className?: string;
  minimizable?: boolean;
}

export function HighlightCard({
  title,
  children,
  footerLeft,
  footerRight,
  className,
  minimizable,
}: HighlightCardProps) {
  const [minimized, setMinimized] = useState(false);

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl bg-background border shadow-md w-[calc(100%-16px)] max-w-[584px] mx-auto",
        className ?? "border-border",
      )}
      style={{
        marginBottom: minimized ? "8px" : "-16px",
        transition: `margin-bottom 180ms ${EASE}`,
      }}
    >
      {/* Header */}
      <div className="flex items-start gap-2 px-4 pt-4 pb-5">
        <p className={cn("flex-1 text-base font-medium text-foreground min-w-0", minimized && "truncate")}>
          {title}
        </p>
        {minimizable && (
          <button
            type="button"
            onClick={() => setMinimized((v) => !v)}
            className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label={minimized ? "Expand question" : "Minimize question"}
          >
            <ChevronDown
              size={18}
              style={{
                transform: minimized ? "rotate(0deg)" : "rotate(180deg)",
                transition: `transform 180ms ${EASE}`,
              }}
            />
          </button>
        )}
      </div>

      {/* Collapsible body — grid trick animates height without knowing it */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: minimized ? "0fr" : "1fr",
          transition: `grid-template-rows 180ms ${EASE}`,
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <div
            style={{
              opacity: minimized ? 0 : 1,
              transition: `opacity 120ms ${EASE}`,
            }}
          >
            {/* Options / Content */}
            <div className="overflow-clip pb-4">{children}</div>

            {/* Footer with border-t */}
            <div className="border-t border-border px-3 py-3 pb-6">
              <div className="flex items-center justify-between">
                <div>{footerLeft}</div>
                <div className="flex items-center gap-2">{footerRight}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
