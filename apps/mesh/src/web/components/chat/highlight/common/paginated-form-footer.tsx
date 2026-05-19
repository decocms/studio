import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { Pagination } from "../pagination";

export interface PaginatedFormFooterLeftProps {
  currentIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  extraLeft?: ReactNode;
}

/**
 * Left half of the multipart decision form footer: form-level controls
 * (e.g. ApprovalLevelSelect) followed by Pagination. Goes into
 * `CollapsibleHighlight`'s `footerLeft` slot so it left-justifies while
 * the action buttons in `footerRight` right-justify with fill space
 * between them.
 */
export function PaginatedFormFooterLeft({
  currentIndex,
  total,
  onPrev,
  onNext,
  extraLeft,
}: PaginatedFormFooterLeftProps) {
  return (
    <div className="flex items-center gap-2">
      <Pagination
        current={currentIndex}
        total={total}
        onPrev={onPrev}
        onNext={onNext}
      />
      {extraLeft}
    </div>
  );
}

export interface PaginatedFormSubmitButtonProps {
  isStreaming: boolean;
  isAllAnswered: boolean;
  onSubmit: () => void;
  submitLabel?: string;
}

/**
 * The Submit button for the multipart decision form. Disabled while
 * streaming or while any item is unanswered; a tooltip explains why.
 *
 * Uses `aria-disabled` (not `disabled`) so the button stays focusable —
 * Radix Tooltip opens on focus, making the disabled-state explanation
 * reachable for keyboard and screen-reader users.
 *
 * Place this LAST in `CollapsibleHighlight`'s `footerRight` slot, after
 * any form-specific buttons (Skip, Deny, Accept All, …).
 */
export function PaginatedFormSubmitButton({
  isStreaming,
  isAllAnswered,
  onSubmit,
  submitLabel = "Submit",
}: PaginatedFormSubmitButtonProps) {
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

  if (!tooltipText) return submitButton;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{submitButton}</TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
