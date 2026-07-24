// apps/api/src/dispatch-queue/thread-gate-queue.ts
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { WorkflowStatus } from "@dbos-inc/dbos-sdk";
import type { ThreadGateContext } from "./thread-gate-workflow";

/** A pending message in a thread's gate queue, surfaced to the UI. */
export interface ThreadQueueItem {
  /** Full DBOS workflow id: `thread-run:{threadId}:{messageId}`. */
  workflowId: string;
  /** The persisted user message id this gate dispatches. */
  messageId: string;
  /** PENDING (slot holder / running or stuck) → running; ENQUEUED → queued. */
  status: "running" | "queued";
  /** Epoch ms the gate was created/enqueued. */
  enqueuedAt: number;
  /** Where the enqueue came from (see `ThreadGateContext.source`). Omitted
   *  when the input didn't load. */
  source?: string;
}

/**
 * Map one `thread-gate` WorkflowStatus row to a queue item. Returns null when
 * the workflow id does not carry this thread's `thread-run:{threadId}:` prefix
 * (defensive — listWorkflows is already prefix-filtered).
 *
 * `status.input` shape: verified against the installed SDK
 * (`@dbos-inc/dbos-sdk@4.21.6`). `WorkflowStatus.input` is typed `unknown[]`
 * (dist/src/workflow.d.ts) — an already-deserialized array of the workflow
 * function's *positional* arguments, NOT a `{ json: [...] }` envelope.
 * `toWorkflowStatus` (dist/src/workflow_management.js) builds it via
 * `safeParsePositionalArgs(serializer, internal.input, internal.serialization)`,
 * which for the default/portable/native serializers all resolve to the plain
 * args array (see `deserializePositionalArgs`, dist/src/serialization.js).
 * `threadGateWorkflowFn(ctx: ThreadGateContext)` (thread-gate-workflow.ts) is
 * registered with that single positional parameter, so `status.input` is
 * `[ctx]` and `status.input?.[0]` is the `ThreadGateContext` itself — no
 * further unwrapping needed.
 */
export function gateStatusToQueueItem(
  status: WorkflowStatus,
  threadId: string,
): ThreadQueueItem | null {
  const prefix = `thread-run:${threadId}:`;
  if (!status.workflowID.startsWith(prefix)) return null;
  const gateCtx = status.input?.[0] as ThreadGateContext | undefined;
  const request = gateCtx?.request as { messageId?: string } | undefined;
  return {
    workflowId: status.workflowID,
    // The durable request carries the persisted message id; fall back to the
    // id suffix (equal for user turns) when input didn't load.
    messageId: request?.messageId ?? status.workflowID.slice(prefix.length),
    // Caller (listThreadGateQueue) pre-filters to PENDING/ENQUEUED, so the
    // else branch is ENQUEUED → "queued".
    status: status.status === "PENDING" ? "running" : "queued",
    enqueuedAt: status.createdAt,
    ...(gateCtx?.source !== undefined ? { source: gateCtx.source } : {}),
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
