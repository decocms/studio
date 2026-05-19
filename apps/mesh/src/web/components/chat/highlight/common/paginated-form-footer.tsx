import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { Pagination } from "../pagination";

export interface PaginatedFormFooterProps {
  currentIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  isStreaming: boolean;
  isAllAnswered: boolean;
  onSubmit: () => void;
  extraLeft?: ReactNode;
  extraRight?: ReactNode;
  submitLabel?: string;
}

/**
 * Shared footer for the multipart decision prompts. Renders pagination on
 * the left, form-specific slots on either side, and a Submit button on the
 * right. Submit is disabled while streaming or while any item is
 * unanswered; in both disabled states a tooltip explains why.
 *
 * The Submit button uses `aria-disabled` (not `disabled`) so it remains
 * focusable — Radix Tooltip opens on focus, making the disabled-state
 * explanation reachable for keyboard and screen-reader users.
 *
 * Returns a fragment of two sibling rows; the consumer must render them
 * inside a `justify-between` flex container (e.g. `CollapsibleHighlight`'s
 * footer slot). `extraLeft` renders before `Pagination`; `extraRight`
 * renders before the Submit button.
 */
export function PaginatedFormFooter({
  currentIndex,
  total,
  onPrev,
  onNext,
  isStreaming,
  isAllAnswered,
  onSubmit,
  extraLeft,
  extraRight,
  submitLabel = "Submit",
}: PaginatedFormFooterProps) {
  const disabled = isStreaming || !isAllAnswered;
  const tooltipText = disabled
    ? isStreaming
      ? "Waiting for the assistant to finish…"
      : "Answer every item to submit"
    : null;

  const submitButton = (
    <Button
      type="button"
      size="sm"
      aria-disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onSubmit();
      }}
      className={cn(
        "h-7 px-2.5 text-xs",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      {submitLabel}
    </Button>
  );

  return (
    <>
      <div className="flex items-center gap-2">
        {extraLeft}
        <Pagination
          current={currentIndex}
          total={total}
          onPrev={onPrev}
          onNext={onNext}
        />
      </div>
      <div className="flex items-center gap-2">
        {extraRight}
        {tooltipText ? (
          <Tooltip>
            <TooltipTrigger asChild>{submitButton}</TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
          </Tooltip>
        ) : (
          submitButton
        )}
      </div>
    </>
  );
}
