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
  isCurrentAnswered: boolean;
  /**
   * Called when the user advances to the next unanswered item OR commits the
   * batch — typically `decisionForm.submitOrAdvance`, which decides which to
   * do based on whether every item is now answered.
   */
  onAdvanceOrSubmit: () => void;
  submitLabel?: string;
  nextLabel?: string;
}

/**
 * Primary action button for the multipart decision form.
 *
 * Labels itself "Next" while any item is unanswered and "Submit" once every
 * item has an answer. The "Next" form advances to the next unanswered item;
 * "Submit" flushes the batch. Both routes are funneled through one handler
 * (`submitOrAdvance`) so the parent doesn't need to fork on state.
 *
 * Disabled states:
 *   - "Next" while the current item is unanswered (so you can't skip without
 *     answering).
 *   - "Submit" while the assistant is still streaming (the flush will fire
 *     automatically once streaming ends; tooltip explains).
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
  isCurrentAnswered,
  onAdvanceOrSubmit,
  submitLabel = "Submit",
  nextLabel = "Next",
}: PaginatedFormSubmitButtonProps) {
  const label = isAllAnswered ? submitLabel : nextLabel;
  const disabled = isAllAnswered ? isStreaming : !isCurrentAnswered;
  const tooltipText = disabled
    ? isAllAnswered
      ? "Waiting for the assistant to finish…"
      : "Answer this item to continue"
    : null;

  const button = (
    <Button
      type="button"
      size="sm"
      aria-disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onAdvanceOrSubmit();
      }}
      className={cn(
        "h-7 px-2.5 text-xs",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      {label}
    </Button>
  );

  if (!tooltipText) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
