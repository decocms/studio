// apps/mesh/src/dispatch-queue/thread-gate-queue.ts
import type { WorkflowStatus } from "@dbos-inc/dbos-sdk";
import type { ChatMessage } from "@/api/routes/decopilot/types";
import type { ThreadGateContext } from "./thread-gate-workflow";

/** A pending message in a thread's gate queue, surfaced to the UI. */
export interface ThreadQueueItem {
  /** Full DBOS workflow id: `thread-run:{threadId}:{messageId}`. */
  workflowId: string;
  /** Trailing segment of the workflow id (the user message id). */
  messageId: string;
  /** Display text of the queued user message. */
  text: string;
  /** PENDING (slot holder / running or stuck) → running; ENQUEUED → queued. */
  status: "running" | "queued";
  /** Epoch ms the gate was created/enqueued. */
  enqueuedAt: number;
}

/** Concatenate the text parts of the last user message. Pure + total. */
export function extractUserMessageText(messages: ChatMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const lastUserIdx = messages.findLastIndex((m) => m?.role === "user");
  if (lastUserIdx === -1) return "";
  const parts = messages[lastUserIdx]?.parts ?? [];
  return parts
    .map((p) =>
      p && typeof p === "object" && (p as { type?: string }).type === "text"
        ? ((p as { text?: string }).text ?? "")
        : "",
    )
    .join("")
    .trim();
}

/**
 * Map one `thread-gate` WorkflowStatus row to a queue item. Returns null when
 * the workflow id does not carry this thread's `thread-run:{threadId}:` prefix
 * (defensive — listWorkflows is already prefix-filtered).
 */
export function gateStatusToQueueItem(
  status: WorkflowStatus,
  threadId: string,
): ThreadQueueItem | null {
  const prefix = `thread-run:${threadId}:`;
  if (!status.workflowID.startsWith(prefix)) return null;
  const gateCtx = status.input?.[0] as ThreadGateContext | undefined;
  const text = extractUserMessageText(gateCtx?.request?.messages ?? []);
  return {
    workflowId: status.workflowID,
    messageId: status.workflowID.slice(prefix.length),
    text,
    status: status.status === "PENDING" ? "running" : "queued",
    enqueuedAt: status.createdAt,
  };
}
