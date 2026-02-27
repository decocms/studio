/**
 * Thread Status Resolution
 *
 * Maps AI SDK stream finish reason and response parts to ThreadStatus.
 * Extracted for testability.
 */

import type { ThreadStatus } from "@/storage/types";

type ResponsePart = {
  type: string;
  text?: string;
  toolName?: string;
  state?: string;
};

/**
 * Resolves the thread status from the AI SDK stream result.
 *
 * @param finishReason - The AI SDK finish reason for the last step
 * @param responseParts - The parts array from the response UIMessage
 * @returns The resolved ThreadStatus
 */
export function resolveThreadStatus(
  finishReason: string | undefined,
  responseParts: ResponsePart[] = [],
): ThreadStatus {
  if (finishReason === "stop") {
    return "completed";
  }

  if (finishReason === "tool-calls") {
    // Check if user_ask is waiting for input
    // Codebase uses "tool-user_ask" part type with states:
    //   "input-available" = waiting for user input (pending)
    //   "output-available" = user has responded (done)
    const hasUserAskPending = responseParts.some(
      (part) =>
        part.type === "tool-user_ask" && part.state === "input-available",
    );

    // Check if any tools are awaiting approval
    const hasApprovalPending = responseParts.some(
      (part) => part.state === "approval-requested",
    );

    return hasUserAskPending || hasApprovalPending
      ? "requires_action"
      : "completed";
  }

  // "length", "content-filter", "error", "other", "unknown", undefined
  return "failed";
}
