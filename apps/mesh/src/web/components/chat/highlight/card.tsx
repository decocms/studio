import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowLeft, ArrowRight } from "@untitledui/icons";

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
}

export function HighlightCard({
  title,
  children,
  footerLeft,
  footerRight,
  className,
}: HighlightCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl bg-background border shadow-md w-[calc(100%-16px)] max-w-[584px] mx-auto mb-[-16px]",
        className ?? "border-border",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-4">
        <p className="flex-1 text-base font-medium text-foreground min-w-0">
          {title}
        </p>
      </div>

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
  );
}
