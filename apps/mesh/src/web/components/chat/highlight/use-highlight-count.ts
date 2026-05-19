/**
 * Derives whether each `CollapsibleHighlight` card in the chat stack should
 * render, plus a count of how many are visible. Both `ChatHighlight` (the
 * stack itself) and `ChatMessages` (the scrollable area above the input)
 * call this so that the scroll area can reserve `n × HIGHLIGHT_COLLAPSED_HEIGHT_PX`
 * of bottom padding — enough room that, when every card is collapsed, the
 * last message can be scrolled flush with the top of the stack.
 *
 * The credit-exhausted case is special: it renders as a modal `Dialog`
 * outside the stack, so it does NOT count toward `n`. The `isCreditExhausted`
 * flag is exposed for `ChatHighlight` to handle the early return.
 *
 * NOTE: The pure extraction helpers (extractPendingApprovals,
 * extractPendingPlans, isCreditError) are intentionally inlined here rather
 * than imported from their respective UI modules (approval.tsx,
 * propose-plan.tsx, credits-exhausted-banner.tsx). Those files pull in heavy
 * React UI components whose transitive dependencies (e.g. @deco/ui) are not
 * available in the bun test environment. The logic is identical to the
 * source-of-truth implementations in those files.
 */

import type { UIMessage } from "ai";
import { deriveCurrentTodos } from "./derive-current-todos";

export interface HighlightFlags {
  isCreditExhausted: boolean;
  hasTodos: boolean;
  showError: boolean;
  showWarning: boolean;
  hasApprovals: boolean;
  hasPlans: boolean;
  isWaitingForUserInput: boolean;
}

export interface DeriveHighlightFlagsInput {
  messages: UIMessage[];
  error: Error | null;
  finishReason: string | null;
  isStreaming: boolean;
  isWaitingForApprovals: boolean;
}

const EMPTY_FLAGS: HighlightFlags = {
  isCreditExhausted: false,
  hasTodos: false,
  showError: false,
  showWarning: false,
  hasApprovals: false,
  hasPlans: false,
  isWaitingForUserInput: false,
};

// ---------------------------------------------------------------------------
// Inlined pure helpers — identical logic to the source files, but without the
// React/UI imports that would break the bun test environment.
// ---------------------------------------------------------------------------

/** Mirror of isCreditError in credits-exhausted-banner.tsx */
function isCreditError(error: Error | null): boolean {
  if (!error) return false;
  return error.message.startsWith("[CREDITS]");
}

type LoosePart = {
  type: string;
  state?: string;
  approval?: { id: string };
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
};

/** Mirror of extractPendingApprovals in approval.tsx */
function extractPendingApprovals(parts: LoosePart[]): LoosePart[] {
  return parts.filter(
    (part) =>
      "state" in part &&
      part.state === "approval-requested" &&
      "approval" in part &&
      part.approval?.id &&
      "toolCallId" in part &&
      part.toolCallId,
  );
}

/** Mirror of extractPendingPlans in propose-plan.tsx */
function extractPendingPlans(parts: LoosePart[]): LoosePart[] {
  return parts.filter(
    (part) =>
      part.type === "tool-propose_plan" &&
      part.state === "input-available" &&
      "toolCallId" in part &&
      "input" in part,
  );
}

// ---------------------------------------------------------------------------

export function deriveHighlightFlags(
  input: DeriveHighlightFlagsInput,
): HighlightFlags {
  const { messages, error, finishReason, isStreaming, isWaitingForApprovals } =
    input;

  // Credit-exhausted is a modal, not a stacked card.
  if (!isStreaming && error && isCreditError(error)) {
    return { ...EMPTY_FLAGS, isCreditExhausted: true };
  }

  const lastMessage = messages.at(-1);
  const assistantParts =
    lastMessage?.role === "assistant" ? lastMessage.parts : [];

  const looseParts = assistantParts as LoosePart[];
  const userAskParts = looseParts.filter(
    (part) => part.type === "tool-user_ask",
  );
  const isWaitingForUserInput = !!userAskParts.filter(
    (p) => p.state !== "output-available",
  ).length;

  const pendingPlans = extractPendingPlans(looseParts);
  const pendingApprovals = extractPendingApprovals(looseParts);

  const todos = deriveCurrentTodos(messages);

  const showError = !isStreaming && !!error;
  const hasApprovals =
    pendingApprovals.length > 0 || (isStreaming && isWaitingForApprovals);
  const hasPlans = pendingPlans.length > 0;

  // Matches the suppression logic in ChatHighlight: `tool-calls` is the
  // expected handoff when the model emits user_ask/propose_plan/approval,
  // so the matching card already covers the situation — suppress the
  // duplicate warning.
  const isToolCallsWaitingOnClient =
    finishReason === "tool-calls" &&
    (isWaitingForUserInput || hasApprovals || hasPlans);
  const showWarning =
    !isStreaming &&
    !!finishReason &&
    finishReason !== "stop" &&
    !isToolCallsWaitingOnClient &&
    !showError;

  return {
    isCreditExhausted: false,
    hasTodos: todos.length > 0,
    showError,
    showWarning,
    hasApprovals,
    hasPlans,
    isWaitingForUserInput,
  };
}
