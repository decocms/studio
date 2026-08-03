/**
 * Thread Status Resolution
 *
 * Maps AI SDK stream finish reason and response parts to ThreadStatus.
 * Extracted for testability.
 */

import type { ThreadStatus } from "@/storage/types";

type ResponsePart = {
  type: string;
  state?: string;
};

/**
 * Resolves the thread status from the AI SDK stream onFinish reason.
 *
 * @param finishReason - The AI SDK finish reason for the last step
 * @param responseParts - The parts array from the response UIMessage
 * @returns The resolved ThreadStatus
 */
export function resolveThreadStatus(
  finishReason: string | undefined,
  responseParts: ResponsePart[] = [],
): Exclude<ThreadStatus, "in_progress"> {
  if (finishReason === "stop") {
    // A clean stop is a finished turn. An agent that needs input signals it
    // structurally — a pending `user_ask` or an `approval-requested` tool part,
    // both handled by the `tool-calls` branch below — never by ending normal
    // prose with a question. We used to infer `requires_action` from a `?` in
    // the final text; that false-positived on any summary mentioning a URL
    // query string (e.g. `fonts.googleapis.com/css2?...`) or a rhetorical
    // question, wedging completed review threads in `requires_action` and
    // blocking the task board from advancing them.
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
