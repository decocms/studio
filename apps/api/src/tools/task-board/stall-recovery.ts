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

import type { StudioContext } from "@/core/studio-context";
import { nudgeThreadTurn } from "./nudge-thread";
import { shouldAdvanceToReview } from "@/storage/task-board";
import type { TaskBoardItem, Thread } from "@/storage/types";
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
}): StallAction {
  if (thread.status === "completed") return "advance";
  // Only v2 threads can take a new turn: dispatch nulls the part emitter for v1
  // (deprecated, read-only), so a nudge would run with nothing persisted and
  // nothing rendered. A failed v1 thread is left In Progress for a human rather
  // than advanced — its work really is unfinished.
  if (
    thread.status === "failed" &&
    thread.messageStorageVersion === 2 &&
    (thread.harnessId === "decopilot" || thread.harnessId === "claude-code")
  ) {
    return "nudge";
  }
  return "none";
}

/**
 * The nudge turn. Harness-aware in one line only: `user_ask` is a Decopilot
 * built-in, so naming it at a sandbox-hosted run would send it hunting for a
 * tool it doesn't have. Everything else holds for both — a re-prompted thread
 * keeps its branch, so its previous run's commits are already in the checkout.
 */
export function nudgePrompt(harnessId: string | null): string {
  return [
    "This task is still In Progress on the board and your last run ended without finishing it.",
    "",
    "Look at what you already did (`git log`, `git status`, and the messages above), then either:",
    "- finish the remaining work (and open the PR, if it needed code changes),",
    "- or, if it's actually done, say so in one line — the board moves the card for you,",
    harnessId === "decopilot"
      ? "- or, if you're blocked on something only a human knows, call the `user_ask` tool."
      : "- or, if you're blocked on something only a human knows, say what you need and stop.",
    "",
    "Don't start over and don't redo work you already committed or pushed. You are on the same branch as before — push to it and update your existing pull request rather than opening a second one.",
  ].join("\n");
}

/** One user turn onto a failed run's thread, at most once ever — the ids below
 *  are the fence (see `nudgeThreadTurn`). */
async function nudgeThread(
  ctx: StudioContext,
  item: TaskBoardItem,
  thread: Thread,
): Promise<void> {
  await nudgeThreadTurn(ctx, item, thread, {
    messageId: `stall-nudge-${item.id}-${thread.id}`,
    prompt: nudgePrompt(thread.harness_id),
    workflowID: `stall-nudge:${item.id}:${thread.id}`,
  });
}

/**
 * Read the one thing the board list doesn't carry — `message_storage_version`,
 * which gates whether the thread can take a new turn at all — and decide. Only
 * runs for a card that already looks stalled, so a healthy board pays nothing.
 */
async function resolveStallAction(
  ctx: StudioContext,
  threadId: string,
): Promise<{ action: StallAction; thread: Thread | null }> {
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread) return { action: "none", thread: null };
  return {
    action: decideStallAction({
      status: thread.status,
      messageStorageVersion: thread.message_storage_version,
      harnessId: thread.harness_id,
    }),
    thread,
  };
}

/** Recorded on a thread whose run never reported progress and can no longer be
 *  owned by any pod. Distinct from `"stall"` (a run that started, streamed, then
 *  went quiet — the in-memory idle reaper's case) so the two are tellable apart
 *  in the DB. */
export const ABANDONED_FAILURE_REASON =
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
    // Only query PRs for a repo-backed task — that's the one gate that needs it.
    let hasPr: boolean;
    try {
      hasPr =
        item.repo != null &&
        (await ctx.storage.taskBoard.listPrs(item.id, organizationId)).length >
          0;
    } catch (err) {
      // Isolated like every other per-item step: a blip here must not skip the rest of the batch.
      console.error(`[task-board] listPrs for ${item.id} failed`, err);
      continue;
    }
    if (!shouldAdvanceToReview(item, hasPr)) continue;
    const thread = item.threads.find((t) => t.hasMessages);
    if (!thread) continue;
    try {
      const { action, thread: row } = await resolveStallAction(
        ctx,
        thread.threadId,
      );
      if (action === "none" || !row) continue;
      if (action === "advance") {
        await advanceTasksToReviewOnThreadFinish(
          ctx.storage.taskBoard,
          thread.threadId,
          organizationId,
          ctx.storage.organizationBilling,
          ctx.db,
        );
      } else {
        await nudgeThread(ctx, item, row);
      }
    } catch (err) {
      console.error(`[task-board] stall recovery failed for ${item.id}`, err);
    }
  }
}
