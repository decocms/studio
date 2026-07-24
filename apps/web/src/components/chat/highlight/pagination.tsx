/**
 * Pagination — "← 1 of 4 →" control used in the footer of highlight banners
 * that span multiple items (questions, approvals).
 *
 * Visual styling matches the rest of the highlight chrome.
 */

import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowLeft, ArrowRight } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

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
  const t = useT();
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
        aria-label={t("chat.pagination.previousLabel")}
      >
        <ArrowLeft size={14} />
      </button>
      <span className="tabular-nums text-xs">
        {t("chat.pagination.counter", { current: current + 1, total })}
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
        aria-label={t("chat.pagination.nextLabel")}
      >
        <ArrowRight size={14} />
      </button>
    </div>
  );
}
