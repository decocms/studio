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
 * What a stalled card needs, if anything. `threads[0]` is the newest link
 * (`attachThreads` orders by `link.created_at desc`), so the last run to
 * happen decides: it completing means the work stands, it failing means it
 * doesn't. Pure — unit-tested.
 */
export function classifyStall(item: {
  status: TaskBoardItem["status"];
  threads: { status: string | null; hasPreview: boolean }[];
}): StallAction {
  if (!shouldAdvanceToReview(item)) return "none";
  return item.threads[0]?.status === "failed" ? "nudge" : "advance";
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
    const action = classifyStall(item);
    const thread = item.threads[0];
    if (action === "none" || !thread) continue;
    try {
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
      console.error(
        `[task-board] stall recovery (${action}) failed for ${item.id}`,
        err,
      );
    }
  }
}
