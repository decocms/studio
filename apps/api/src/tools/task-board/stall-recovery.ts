/**
 * Board-open stall recovery.
 *
 * The projector's thread-finish hook (`advanceTasksToReviewOnThreadFinish`) is
 * what normally moves a task off In Progress once its threads are done. When
 * that hook misses — the pod died mid-terminal-write, projection failed — the
 * card sits In Progress forever with nothing running behind it. Opening the
 * board re-runs the same decision over the list it just loaded:
 *
 *   every thread terminal, newest `completed` → advance to In Review. This is
 *     the finish hook's own job, done late; costs two queries, no model call.
 *   every thread terminal, newest `failed`    → nudge the thread once: one user
 *     turn asking the agent to finish what it started. Advancing here would
 *     mark unfinished work as reviewable.
 *   any thread `requires_action` / `in_progress` → leave it. The first is parked
 *     on a `user_ask` (a human owns it), the second is either live or the stall
 *     reaper's to fail — and once it does, the next board open nudges it.
 *
 * Called fire-and-forget from TASK_BOARD_ITEM_LIST: it never delays or fails
 * the read.
 */

import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { resolveTier } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import { enqueueThreadRun } from "@/dispatch-queue";
import { shouldAdvanceToReview } from "@/storage/task-board";
import type { TaskBoardItem, TaskBoardItemThreadRef } from "@/storage/types";
import { getDecopilotId } from "@decocms/shared/sdk";
import { advanceTasksToReviewOnThreadFinish } from "./run-reactions";

export type StallAction = "none" | "advance" | "nudge";

/**
 * What a stalled card needs, given the newest linked thread's authoritative
 * state. Pure — unit-tested.
 *
 * `hasHistory` is load-bearing, not defensive. `ThreadStorage.create` defaults
 * `status` to `"completed"`, so a thread is born terminal: an empty chat
 * someone opened next to a card is indistinguishable *by status* from a run
 * that finished. The projector's finish hook can't be fooled by that — a
 * terminal event proves a run happened — but this runs off state, where that
 * proof has to be fetched. Prod has exactly one card in this shape, and
 * advancing it would call work reviewable that nobody ever started.
 */
export function decideStallAction(thread: {
  status: string | null;
  hasHistory: boolean;
  messageStorageVersion: number;
}): StallAction {
  if (!thread.hasHistory) return "none";
  if (thread.status === "completed") return "advance";
  // Only v2 threads can take a new turn: dispatch nulls the part emitter for v1
  // (deprecated, read-only), so a nudge would run with nothing persisted and
  // nothing rendered. A failed v1 thread is left In Progress for a human rather
  // than advanced — its work really is unfinished.
  if (thread.status === "failed" && thread.messageStorageVersion === 2) {
    return "nudge";
  }
  return "none";
}

const NUDGE_PROMPT = [
  "This task is still In Progress on the board and your last run ended without finishing it.",
  "",
  "Look at what you already did, then either:",
  "- finish the remaining work (and open the PR, if it needed code changes),",
  "- or, if it's actually done, say so in one line — the board moves the card for you,",
  "- or, if you're blocked on something only a human knows, call the `user_ask` tool.",
  "",
  "Don't start over and don't redo work you already committed or pushed.",
].join("\n");

/**
 * Send one user turn onto a failed run's thread. Everything here is keyed off
 * (task, thread) rather than a fresh id: the message id makes the part write
 * idempotent, and the workflowID makes the enqueue collapse — so two board
 * opens racing each other, or one every 30s for a week, still produce exactly
 * one nudge run. That is also why there's no separate "already nudged" marker.
 */
async function nudgeThread(
  ctx: StudioContext,
  item: TaskBoardItem,
  thread: TaskBoardItemThreadRef,
): Promise<void> {
  const organizationId = item.organizationId;
  const model = await resolveTier(ctx, "smart");
  const agentId = thread.virtualMcpId ?? getDecopilotId(organizationId);

  const requestMessage = {
    id: `stall-nudge-${item.id}-${thread.threadId}`,
    role: "user" as const,
    parts: [{ type: "text" as const, text: NUDGE_PROMPT }],
  };

  // Persist the user turn before dispatch, for the same ordering reason as
  // enqueueSuperAgentForTask: the projector can otherwise land the reply first
  // and invert the two in the UI.
  await new PartEmitter({
    storage: ctx.storage.threads.messageParts(),
    orgId: organizationId,
    threadId: thread.threadId,
    runId: thread.threadId,
  }).emitRequestMessage(requestMessage);

  await enqueueThreadRun(
    {
      threadId: thread.threadId,
      source: "background-tool",
      request: {
        messages: [requestMessage],
        models: {
          credentialId: model.credentialId,
          thinking: { id: model.modelId, title: model.modelMeta.title },
        },
        agent: { id: agentId },
        temperature: 0.5,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId,
        userId: item.assignedBy ?? item.createdBy,
        taskId: thread.threadId,
        runMetadata: { taskBoardItemId: item.id },
      },
    },
    { workflowID: `stall-nudge:${item.id}:${thread.threadId}` },
  );
}

/**
 * Read the newest thread's authoritative state and decide. Two reads the board
 * list doesn't carry: `message_storage_version` (not in the public thread ref)
 * and whether any message exists at all — the same `limit: 1` probe POST
 * /messages uses to spot a never-used thread, so it spans v1 and v2 alike.
 * Only runs for a card that already looks stalled, so a healthy board pays
 * nothing.
 */
async function resolveStallAction(
  ctx: StudioContext,
  threadId: string,
): Promise<StallAction> {
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread) return "none";
  const { total } = await ctx.storage.threads.listMessages(threadId, {
    limit: 1,
  });
  return decideStallAction({
    status: thread.status,
    hasHistory: total > 0,
    messageStorageVersion: thread.message_storage_version,
  });
}

/**
 * Recover every stalled card in a freshly-read board. Takes the items the read
 * already loaded, so detection costs nothing. Best-effort per task: one card's
 * failure never stops the others, and none of it ever reaches the caller.
 */
export async function recoverStalledTasks(
  ctx: StudioContext,
  items: TaskBoardItem[],
): Promise<void> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) return;

  for (const item of items) {
    // Narrow off the already-loaded list first, so a board with nothing stuck
    // costs zero queries. `threads[0]` is the newest link (`attachThreads`
    // orders by `link.created_at desc`) — the last run to happen decides.
    if (!shouldAdvanceToReview(item)) continue;
    const thread = item.threads[0];
    if (!thread) continue;
    try {
      const action = await resolveStallAction(ctx, thread.threadId);
      if (action === "none") continue;
      if (action === "advance") {
        await advanceTasksToReviewOnThreadFinish(
          ctx.storage.taskBoard,
          thread.threadId,
          organizationId,
        );
      } else {
        await nudgeThread(ctx, item, thread);
      }
    } catch (err) {
      console.error(`[task-board] stall recovery failed for ${item.id}`, err);
    }
  }
}
