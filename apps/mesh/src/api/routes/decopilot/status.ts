/**
 * Thread Status Resolution
 *
 * Maps AI SDK stream finish reason and response parts to ThreadStatus.
 * Extracted for testability.
 */

import type { ThreadStatus } from "@/storage/types";

/**
 * Accepts both the UI-message-stream parts shape (emitted via
 * `createUIMessageStream` -> the response's `parts` array, used by the
 * UI-stream-level `onFinish`) and the raw AI SDK `ContentPart` shape
 * (emitted via `streamText.onFinish`'s `content`). The two diverge for
 * tool-call/approval parts: UI parts use `type: "tool-<toolName>"` plus a
 * `state` field, while AI SDK content uses `type: "tool-call"` with a
 * `toolName` field and `type: "tool-approval-request"` for approvals.
 * `text` parts are identical in both shapes.
 */
type ResponsePart = {
  type: string;
  text?: string;
  toolName?: string;
  state?: string;
};

/**
 * Resolves the thread status from the AI SDK stream onFinish reason.
 *
 * @param finishReason - The AI SDK finish reason for the last step
 * @param responseParts - Either UI-message parts or streamText `content` items
 * @returns The resolved ThreadStatus
 */
export function resolveThreadStatus(
  finishReason: string | undefined,
  responseParts: ResponsePart[] = [],
): Exclude<ThreadStatus, "in_progress"> {
  if (finishReason === "stop") {
    const text = responseParts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");

    // Strip URLs so their query strings don't trigger a false positive
    const textWithoutUrls = text.replace(/https?:\/\/[^\s)>\]]+/g, "");
    return textWithoutUrls.includes("?") ? "requires_action" : "completed";
  }

  if (finishReason === "tool-calls") {
    // user_ask pending — two equivalent encodings:
    //   UI parts:        { type: "tool-user_ask", state: "input-available" }
    //   AI SDK content:  { type: "tool-call", toolName: "user_ask" }
    //                    (no matching tool-result, since finishReason is
    //                    "tool-calls" → model stopped awaiting tool execution)
    const hasUserAskPending = responseParts.some(
      (part) =>
        (part.type === "tool-user_ask" && part.state === "input-available") ||
        (part.type === "tool-call" && part.toolName === "user_ask"),
    );

    // Tool awaiting approval — two equivalent encodings:
    //   UI parts:        { state: "approval-requested" } (any type)
    //   AI SDK content:  { type: "tool-approval-request" }
    const hasApprovalPending = responseParts.some(
      (part) =>
        part.state === "approval-requested" ||
        part.type === "tool-approval-request",
    );

    return hasUserAskPending || hasApprovalPending
      ? "requires_action"
      : "completed";
  }

  // "length", "content-filter", "error", "other", "unknown", undefined
  return "failed";
}
