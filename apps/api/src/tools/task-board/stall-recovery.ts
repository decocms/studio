/**
 * Board-open stall recovery.
 *
 * The projector's thread-finish hook (`advanceTasksToReviewOnThreadFinish`) is
 * what normally moves a task off In Progress once its threads are done. When
 * that hook misses — the pod died mid-terminal-write, projection failed — the
 * card sits In Progress forever with nothing running behind it. Opening the
 * board re-runs the same decision over the list it just loaded:
 *
 *   every used thread terminal, newest `completed` → advance to In Review. This
 *     is the finish hook's own job, done late; costs two queries, no model call.
 *   every used thread terminal, newest `failed`    → nudge the thread once: one
 *     user turn asking the agent to finish what it started. Advancing here would
 *     mark unfinished work as reviewable.
 *   any thread `requires_action` / `in_progress` → leave it. The first is parked
 *     on a `user_ask` (a human owns it), the second is either live or the stall
 *     reaper's to fail — and once it does, the next board open nudges it.
 *
 * With ONE exception, added because "the stall reaper's to fail" was not true of
 * every `in_progress` thread: a run that never STARTED (see
 * `failNeverStartedThreads`) has no entry in any pod's `RunRegistry`, so the
 * in-memory idle reaper cannot see it and no DB sweep exists. Those threads sat
 * `in_progress` with zero parts indefinitely, and because
 * `shouldAdvanceToReview` requires every thread terminal, one of them froze its
 * whole card — no advance, no nudge, forever. We fail them here first, which
 * both unblocks the gate below and gives the card a legible reason.
 *
 * "Used" is `shouldAdvanceToReview`'s filter: threads with no messages don't
 * count, because a never-typed-in chat is born `completed`.
 *
 * Called fire-and-forget from TASK_BOARD_ITEM_LIST: it never delays or fails
 * the read.
 */

import { taskRunMetadata } from "../../billing/subsidized-runs";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { resolveTier } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import { enqueueThreadRun } from "@/dispatch-queue";
import { isHostedDecopilotRuntime } from "@/harnesses/decopilot/hosted-runtime";
import { shouldAdvanceToReview } from "@/storage/task-board";
import type {
  TaskBoardItem,
  TaskBoardItemThreadRef,
  Thread,
} from "@/storage/types";
import { getDecopilotId } from "@decocms/shared/sdk";
import { advanceTasksToReviewOnThreadFinish } from "./run-reactions";
import { isThreadRunStale } from "@/tools/thread/helpers";

export type StallAction = "none" | "advance" | "nudge";

/**
 * What a stalled card needs, given the newest used thread's state. Reached only
 * for a card `shouldAdvanceToReview` already accepted, so every thread in play
 * has messages and a terminal status. Pure — unit-tested.
 */
export function decideStallAction(thread: {
  status: string | null;
  messageStorageVersion: number;
  harnessId: string | null;
  sandboxProviderKind: string | null;
}): StallAction {
  if (thread.status === "completed") return "advance";
  // Only v2 threads can take a new turn: dispatch nulls the part emitter for v1
  // (deprecated, read-only), so a nudge would run with nothing persisted and
  // nothing rendered. A failed v1 thread is left In Progress for a human rather
  // than advanced — its work really is unfinished.
  if (
    thread.status === "failed" &&
    thread.messageStorageVersion === 2 &&
    isHostedDecopilotRuntime(thread)
  ) {
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
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: thread.threadId,
        runMetadata: taskRunMetadata(item),
      },
    },
    { workflowID: `stall-nudge:${item.id}:${thread.threadId}` },
  );
}

/**
 * Read the one thing the board list doesn't carry — `message_storage_version`,
 * which gates whether the thread can take a new turn at all — and decide. Only
 * runs for a card that already looks stalled, so a healthy board pays nothing.
 */
async function resolveStallAction(
  ctx: StudioContext,
  threadId: string,
): Promise<StallAction> {
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread) return "none";
  return decideStallAction({
    status: thread.status,
    messageStorageVersion: thread.message_storage_version,
    harnessId: thread.harness_id,
    sandboxProviderKind: thread.sandbox_provider_kind,
  });
}

/** Recorded on a thread whose run never reported progress and can no longer be
 *  owned by any pod. Distinct from `"stall"` (a run that started, streamed, then
 *  went quiet — the in-memory idle reaper's case) so the two are tellable apart
 *  in the DB. */
const ABANDONED_FAILURE_REASON =
  "Run never started — no pod picked it up before the idle window elapsed";

/**
 * True for a thread whose run NEVER STARTED and is now too old to ever start.
 *
 * The in-memory idle reaper only sees runs present in a pod's `RunRegistry`,
 * i.e. runs that reached `RUN_STARTED`. A thread whose dispatch never got that
 * far — the enqueue landed, the row was written `in_progress`, and nothing ever
 * ran — is invisible to it on every pod, and no DB sweep exists.
 *
 * `run_started_at` is the discriminator: set means a run really did begin, and
 * that one belongs to the idle reaper / DBOS recovery, which can still resume
 * it. Staleness is the shared `isThreadRunStale` test (the same one that renders
 * "expired" in thread responses), so a live run is never touched.
 *
 * Pure — unit-tested.
 */
export function isNeverStartedRun(
  thread: Pick<Thread, "status" | "run_started_at" | "updated_at"> &
    Pick<Thread, "last_progress_at">,
  now: number = Date.now(),
): boolean {
  if (thread.status !== "in_progress") return false;
  if (thread.run_started_at) return false;
  return isThreadRunStale(thread, now);
}

/**
 * Fail the card's `in_progress` threads that no run can still be behind.
 *
 * Returns the ids it failed, so the caller can skip a card it just changed and
 * let the next board open act on fresh data rather than a stale in-memory list.
 */
async function failNeverStartedThreads(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<string[]> {
  const failed: string[] = [];
  for (const ref of item.threads) {
    if (ref.status !== "in_progress") continue;
    const thread = await ctx.storage.threads.get(ref.threadId);
    if (!thread || !isNeverStartedRun(thread)) continue;
    const marked = await ctx.storage.threads.markRunFailed(
      ref.threadId,
      ABANDONED_FAILURE_REASON,
      "abandoned",
    );
    if (marked) {
      failed.push(ref.threadId);
      console.warn(
        `[task-board] failed never-started thread ${ref.threadId} on ${item.id}`,
      );
    }
  }
  return failed;
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
    // First clear any never-started thread blocking this card's gate below.
    // Skipped for a card that isn't parked In Progress: In Review / Done cards
    // are not waiting on a run, and a card a human is actively working has no
    // stuck agent thread to reap.
    if (item.status === "in_progress") {
      try {
        const reaped = await failNeverStartedThreads(ctx, item);
        // `item.threads` is now stale for this card — the statuses the gate
        // reads were loaded before the writes above. Let the next board open
        // (or the finish hook) act on it rather than reasoning off stale rows.
        if (reaped.length > 0) continue;
      } catch (err) {
        console.error(
          `[task-board] reaping threads for ${item.id} failed`,
          err,
        );
      }
    }
    // Narrow off the already-loaded list first, so a board with nothing stuck
    // costs zero queries. Threads are newest-first (`attachThreads` orders by
    // `link.created_at desc`), so the newest *used* one is the last run to have
    // happened — an empty thread linked afterwards must not shadow it.
    if (!shouldAdvanceToReview(item)) continue;
    const thread = item.threads.find((t) => t.hasMessages);
    if (!thread) continue;
    try {
      const action = await resolveStallAction(ctx, thread.threadId);
      if (action === "none") continue;
      if (action === "advance") {
        await advanceTasksToReviewOnThreadFinish(
          ctx.storage.taskBoard,
          thread.threadId,
          organizationId,
          ctx.storage.organizationBilling,
        );
      } else {
        await nudgeThread(ctx, item, thread);
      }
    } catch (err) {
      console.error(`[task-board] stall recovery failed for ${item.id}`, err);
    }
  }
}
