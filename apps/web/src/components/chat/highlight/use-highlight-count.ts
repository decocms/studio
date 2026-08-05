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
 */

import type { UIMessage } from "ai";
import type { Todo } from "@decocms/shared/harness/todo-write";
import { deriveCurrentTodos } from "./derive-current-todos";
import { extractPendingApprovals } from "./extract-pending-approvals";
import { extractPendingPlans } from "./extract-pending-plans";
import { isCreditError } from "../is-credit-error";
import { subscriptionErrorKind } from "@/components/task-board/is-subscription-error";
import { useChatStream } from "../context";

export interface HighlightFlags {
  isCreditExhausted: boolean;
  /** Non-null when the run errored on the org's auto-task quota — e.g. a
   *  reviewer thread bouncing the task back to the Super Agent hit the
   *  org/task's execution limit. Renders inline, not as a sales paywall (this
   *  is an automated review flow, not a user-initiated purchase moment) —
   *  see `SubscriptionLimitHighlight`. */
  subscriptionErrorKind: ReturnType<typeof subscriptionErrorKind>;
  hasTodos: boolean;
  showError: boolean;
  showWarning: boolean;
  hasApprovals: boolean;
  hasPlans: boolean;
  isWaitingForUserInput: boolean;
  // Exposed so `TodosHighlight` doesn't re-run the same backward scan over
  // `messages` that this hook already did to compute `hasTodos`.
  todos: Todo[];
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
  subscriptionErrorKind: null,
  hasTodos: false,
  showError: false,
  showWarning: false,
  hasApprovals: false,
  hasPlans: false,
  isWaitingForUserInput: false,
  todos: [],
};

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

  type LoosePart = {
    type: string;
    state?: string;
    approval?: { id: string };
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
  };
  const looseParts = assistantParts as LoosePart[];
  const userAskParts = looseParts.filter(
    (part) => part.type === "tool-user_ask",
  );
  const isWaitingForUserInput = !!userAskParts.filter(
    (p) => p.state !== "output-available",
  ).length;

  const pendingPlans = extractPendingPlans(
    assistantParts as Parameters<typeof extractPendingPlans>[0],
  );
  const pendingApprovals = extractPendingApprovals(looseParts);

  const todos = deriveCurrentTodos(messages);

  // A subscription-quota error renders as its own inline card (with tailored
  // copy, no CTA — see SubscriptionLimitHighlight), not the generic raw-message
  // error card.
  const subKind = !isStreaming ? subscriptionErrorKind(error) : null;
  const showError = !isStreaming && !!error && !subKind;
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
    subscriptionErrorKind: subKind,
    hasTodos: todos.length > 0,
    showError,
    showWarning,
    hasApprovals,
    hasPlans,
    isWaitingForUserInput,
    todos,
  };
}

/**
 * Reads the current `useChatStream()` state and returns the highlight flags.
 * Use this in any component under `ChatProvider` that needs to react to
 * which highlights are rendered.
 */
export function useHighlightFlags(): HighlightFlags {
  const { messages, error, finishReason, isStreaming, isWaitingForApprovals } =
    useChatStream();

  return deriveHighlightFlags({
    messages,
    error: error ?? null,
    finishReason: finishReason ?? null,
    isStreaming,
    isWaitingForApprovals,
  });
}

/**
 * Counts how many `CollapsibleHighlight` cards are currently rendered in
 * the stack (excludes the credit-exhausted modal). Multiply by
 * `HIGHLIGHT_COLLAPSED_HEIGHT_PX` to get the bottom padding needed on the
 * messages scroll area so that, when every card is collapsed, the last
 * message can be scrolled flush against the top of the stack.
 */
export function useHighlightCount(): number {
  const flags = useHighlightFlags();
  if (flags.isCreditExhausted) return 0;
  return (
    Number(flags.hasTodos) +
    Number(flags.showError) +
    Number(!!flags.subscriptionErrorKind) +
    Number(flags.showWarning) +
    Number(flags.hasApprovals) +
    Number(flags.hasPlans) +
    Number(flags.isWaitingForUserInput)
  );
}
