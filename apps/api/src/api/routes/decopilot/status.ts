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
    // Finished turn. "Needs input" comes only from the structured `tool-calls`
    // signals below (user_ask / approval), never from a `?` in the prose.
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

/**
 * Terminal status for a run whose stream ended CLEANLY — no in-band `error`
 * chunk. The one rule both terminal writers must share: the live run-reactor
 * (`dispatch-run`'s finish hook) and the durable projector.
 *
 * An ABSENT finishReason means "this stream carried no AI-SDK `finish` chunk",
 * not "the run failed" — `resolveThreadStatus(undefined, …)` reports failed,
 * which is right for a hosted stream that reported `unknown` but wrong for the
 * desktop/relay path and for any harness whose turn ends on `{done}`.
 *
 * The two writers disagreeing is not a cosmetic drift, it is unrecoverable: the
 * live write lands first and is what the projector's `in_progress`-guarded
 * `completeRunIfNotCompleted` then refuses to overwrite. A whole successful turn
 * — reply, PR and all — ends up stored as `failed` with no reason.
 */
export function resolveCleanRunStatus(
  finishReason: string | undefined,
  responseParts: ResponsePart[] = [],
): Exclude<ThreadStatus, "in_progress"> {
  if (finishReason == null) return "completed";
  return resolveThreadStatus(finishReason, responseParts);
}
