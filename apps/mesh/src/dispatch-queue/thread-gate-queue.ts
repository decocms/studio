// apps/mesh/src/dispatch-queue/thread-gate-queue.ts
import { DBOS } from "@dbos-inc/dbos-sdk";
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

/** Concatenate the text parts of the last user message, concatenated and trimmed for display. Pure + total. */
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
    // Caller (listThreadGateQueue) pre-filters to PENDING/ENQUEUED, so the
    // else branch is ENQUEUED → "queued".
    status: status.status === "PENDING" ? "running" : "queued",
    enqueuedAt: status.createdAt,
  };
}

/**
 * List a thread's pending gate workflows (PENDING head + ENQUEUED tail) as
 * UI queue items, oldest first. Reads `workflow_status` via DBOS.listWorkflows
 * (the queue lives there — `workflow_queue` is unused in this DBOS version).
 */
export async function listThreadGateQueue(
  threadId: string,
): Promise<ThreadQueueItem[]> {
  const rows = await DBOS.listWorkflows({
    workflow_id_prefix: `thread-run:${threadId}:`,
    status: ["PENDING", "ENQUEUED"],
    loadInput: true,
    loadOutput: false,
  });
  return rows
    .map((r) => gateStatusToQueueItem(r, threadId))
    .filter((i): i is ThreadQueueItem => i !== null)
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/**
 * Cancel one gate workflow, guarded by the thread prefix (the tenant authz —
 * the caller has already verified thread ownership). Returns false when the id
 * is not scoped to this thread (caller should 404).
 */
export async function cancelThreadGateWorkflow(
  threadId: string,
  workflowId: string,
): Promise<boolean> {
  if (!workflowId.startsWith(`thread-run:${threadId}:`)) return false;
  await DBOS.cancelWorkflows([workflowId]);
  return true;
}

/**
 * Cancel the thread's PENDING gate(s) — the slot holder(s). Used by the stop
 * button so "stop" frees a stuck/wedged head; ENQUEUED items are left intact so
 * the queue continues (Codex semantics). No-op when nothing is PENDING.
 */
export async function cancelThreadGateHead(threadId: string): Promise<void> {
  const pending = await DBOS.listWorkflows({
    workflow_id_prefix: `thread-run:${threadId}:`,
    status: ["PENDING"],
    loadInput: false,
    loadOutput: false,
  });
  if (pending.length === 0) return;
  await DBOS.cancelWorkflows(pending.map((w) => w.workflowID));
}
