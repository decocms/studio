/**
 * Re-run a task with the Super Agent.
 *
 * There was no way to do this. Every Super Agent dispatch hung off a
 * TRANSITION — `TASK_BOARD_ITEM_UPDATE` fired a run only when `assigneeId`
 * *changed* to `super-agent` — so a task already assigned to the Super Agent
 * had nothing left to transition. Re-sending `assigneeId: "super-agent"` was a
 * silent no-op: the write happened, the activity diff was empty, the board
 * re-rendered, and no run was queued. Observed in prod as an entire board of 63
 * items, all `assignee_id = 'super-agent'`, none of them re-runnable by any
 * means the product exposed — not the card's Auto-fix button (hidden once
 * assigned), not the assignee picker (no diff, so no Save), not a lane drag
 * (status changes dispatch nothing).
 *
 * `delegatesToSuperAgent` (`update.ts`) now re-dispatches an explicit
 * delegation of a card sitting in To Do, so that one lane recovers itself. This
 * tool stays the answer for every other lane, and is the only path that TAKES
 * OVER a card wedged behind a thread that will never finish.
 *
 * The other three ways a run gets re-queued are all reactions the user cannot
 * invoke: a reviewer's `request_changes`, an approved-PR merge conflict, and the
 * board-open stall nudge (which only re-prompts an existing FAILED thread, and
 * collapses by a fixed workflow id so it can never fire twice).
 *
 * So this is a deliberate, explicit user action, and it TAKES OVER: any linked
 * thread still holding the task open is failed AND its run stopped (see
 * `stopSupersededRun` — failing the row alone left the old agent running). That
 * is the whole point — the cards that need this are the ones wedged behind a
 * thread that will never finish. The confirmation belongs in the UI, where the
 * human is; by the time the tool is called the decision is made.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  type StudioContext,
} from "@/core/studio-context";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { TERMINAL_THREAD_STATUSES } from "@/storage/task-board";
import { broadcastRunCancel } from "@/api/routes/decopilot/cancel-registry";
import { cancelHostedHarness } from "@/dispatch-queue";
import { cancelThreadGateHead } from "@/dispatch-queue/thread-gate-queue";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { enqueueSuperAgentForTask } from "./enqueue-super-agent";
import {
  ensureTaskExecutionAllowed,
  userInitiatedTaskQuotaConfig,
} from "@/billing/task-quota";

/** Recorded on a thread this re-run took over. */
const SUPERSEDED_FAILURE_REASON = "Superseded by a manual re-run of this task";

/**
 * The threads a re-run has to clear out of the way: the ones still holding the
 * task open. A `null` status is a thread the board could not resolve, and is
 * left alone rather than failed on a guess.
 *
 * `requires_action` IS included: a run parked on a `user_ask` nobody will ever
 * answer is one of the two shapes that wedges a card, and re-running is the user
 * answering "forget it, start over". Automatic writers must never touch that
 * status — see `failIfNotTerminal`, which is why the takeover uses it instead of
 * `markRunFailed`.
 *
 * Pure — unit-tested.
 */
export function threadsToSupersede(item: {
  threads: { threadId: string; status: string | null }[];
}): string[] {
  return item.threads
    .filter(
      (thread) =>
        thread.status !== null && !TERMINAL_THREAD_STATUSES.has(thread.status),
    )
    .map((thread) => thread.threadId);
}

/**
 * Stop the run behind a superseded thread — not just its row.
 *
 * The takeover used to be the DB write alone: `failIfNotTerminal` flipped the
 * thread to `failed` and the agent kept running, because its `AbortController`
 * lives in a pod's `RunRegistry` and nothing here reached it.
 *
 * Observed in prod (`board_EnT6dU9ltgxS4fxAZxVXC`): a card whose live stream
 * had gone quiet looked frozen, so the user pressed Re-run at 16:23. The run
 * was alive. Seven minutes later it pushed a branch, opened PR #306, commented
 * on the card and moved it to In Review — while the re-run's own agent did the
 * same work and opened PR #307 on the same files. Two Super Agent runs, one
 * task, two conflicting PRs, and a "failed" thread that shipped one of them.
 *
 * Mirrors `cancelActiveThreadRun` (routes.ts) minus the ghost force-fail, which
 * the caller's `failIfNotTerminal` has already done. Every step is best-effort
 * and ordered after that write, so the superseded reason wins the race against
 * the registry's own `cancelled` terminal (both are guarded on `in_progress`),
 * and an unreachable old run never blocks queueing the new one.
 */
async function stopSupersededRun(
  ctx: StudioContext,
  threadId: string,
  organizationId: string,
): Promise<void> {
  const onError = (step: string) => (err: unknown) =>
    console.error("[task-board] rerun takeover step failed", {
      threadId,
      step,
      err,
    });

  // Durable intent, so the ingest backstop rejects the old run's appends even
  // if no pod is holding it in memory to abort.
  await ctx.storage.threads
    .setCancelRequested(threadId, organizationId)
    .catch(onError("cancel-flag"));

  // A run still parked as the PENDING gate head has no in-memory registry entry
  // to abort; cancelling the workflow is what frees its partition slot.
  await cancelThreadGateHead(threadId).catch(onError("gate-head"));

  // The hosted child can't be interrupted mid-step, but cancelling it stops a
  // still-queued attempt outright and bars DBOS from resurrecting this one.
  const fence = await ctx.storage.threads
    .getRunFence(threadId)
    .catch(() => null);
  if (fence) {
    await cancelHostedHarness(threadId, fence).catch(onError("hosted-harness"));
  }

  // The one call that actually interrupts a running agent loop: local abort
  // plus cross-pod fan-out to whichever pod owns the run.
  broadcastRunCancel(threadId);
}

export const TASK_BOARD_ITEM_RERUN = defineTool({
  name: "TASK_BOARD_ITEM_RERUN",
  description:
    "Re-run a task board item with the Super Agent, whatever lane it is in. " +
    "Use this to retry a task that stalled, finished without doing the job, or " +
    "is already assigned to the Super Agent (in which case re-assigning it " +
    "does nothing). Fails any run still holding the task open, moves it to In " +
    "Progress, and queues a fresh run.",
  annotations: {
    title: "Re-run Task",
    readOnlyHint: false,
    // Fails in-flight runs and starts a new one that will push commits.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  // ponytail: no `feedback` / "what to do differently" input. The only prompt
  // lead that exists for a re-run is the reviewer's ("A reviewer requested
  // changes on your previous work"), which would be a lie here. Add one when
  // there is a caller for it, with its own lead.
  inputSchema: z.object({
    id: z.string().describe("The task board item to re-run."),
  }),
  outputSchema: z.object({
    status: z.string().describe("The task's lane after the re-run was queued."),
    supersededThreadIds: z
      .array(z.string())
      .describe("Runs that were failed to make room for this one."),
  }),
  handler: async ({ id }, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const item = await ctx.storage.taskBoard.getById(id, organizationId);
    if (!item) throw new Error(`Task board item not found: ${id}`);

    // A re-run is a Super Agent run, so the task must be the Super Agent's.
    // Re-assigning a human's task away from them as a side effect of "retry"
    // would be a surprise; the caller reassigns first if that's what they want
    // (and that transition dispatches on its own).
    if (item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) {
      throw new Error(
        "Only a task assigned to the Super Agent can be re-run. Assign it to " +
          "the Super Agent instead — that queues a run by itself.",
      );
    }

    // Paywall before any write: a refused re-run must leave the card untouched.
    await ensureTaskExecutionAllowed(ctx, item, userInitiatedTaskQuotaConfig());

    // Take over: fail every thread still holding the task open. `failIfNotTerminal`
    // rather than `markRunFailed` because a `requires_action` thread has to be
    // closed out too — it is non-terminal to `shouldAdvanceToReview`, so leaving
    // one behind means this task can never auto-advance again however many later
    // runs succeed. Still a conditional UPDATE, so a thread that settles in the
    // gap between the read above and this write keeps its real terminal state
    // (and is then absent from the returned list).
    const supersededThreadIds: string[] = [];
    for (const threadId of threadsToSupersede(item)) {
      const marked = await ctx.storage.threads.failIfNotTerminal(
        threadId,
        SUPERSEDED_FAILURE_REASON,
        "superseded",
      );
      if (!marked) continue;
      supersededThreadIds.push(threadId);
      // Only for a thread this call really took over: a run that settled on its
      // own in the gap above is already finished, and cancelling it would stamp
      // a cancel over a real terminal.
      await stopSupersededRun(ctx, threadId, organizationId);
    }

    // In Progress before dispatch, so the card reads as running the moment the
    // board refreshes rather than sitting in its old lane until the run's first
    // chunk lands. `enqueueSuperAgentForTask` claims quota itself (idempotent
    // per task, and exempt from `maxRunsPerTask`) and throws
    // `TaskQuotaError` on an empty period bucket — which must surface, so NOT
    // best-effort: a swallowed failure here is exactly the silent no-op this
    // tool exists to remove.
    const updated = await ctx.storage.taskBoard.update(
      id,
      organizationId,
      { status: "in_progress" },
      getUserId(ctx)!,
    );

    await recordTaskActivity(ctx, {
      taskBoardItemId: id,
      action: "status_changed",
      actorId: getUserId(ctx)!,
      data: { from: item.status, to: "in_progress", reason: "rerun" },
    });
    emitTaskBoardUpdated(organizationId, updated);

    await enqueueSuperAgentForTask(ctx, updated, { userInitiated: true });

    return { status: updated.status, supersededThreadIds };
  },
});
