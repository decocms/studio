import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
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
  const tooltipText = isStreaming
    ? "Waiting for the assistant to finish…"
    : !isAllAnswered
      ? "Answer every item to submit"
      : null;

  const submitButton = (
    <Button
      type="button"
      size="sm"
      disabled={disabled}
      onClick={onSubmit}
      className="h-7 px-2.5 text-xs"
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
            <TooltipTrigger asChild>
              {/* span wrapper: disabled buttons don't fire pointer events
                  on their own, so Tooltip needs a non-disabled child */}
              <span>{submitButton}</span>
            </TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
          </Tooltip>
        ) : (
          submitButton
        )}
      </div>
    </>
  );
}
