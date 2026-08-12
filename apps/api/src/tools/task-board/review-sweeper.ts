/**
 * Periodic reconciler for Super Agent tasks parked In Review.
 *
 * It exists because the headless hand-off to the reviewers never worked, for two
 * independent reasons, and both are invisible from inside a DBOS workflow:
 *
 * 1. **The PR was never linked.** `capturePrForRun` is only reachable from the
 *    NATIVE Decopilot loop — the `onPrOpened` MCP wrapper and the `onStepFinish`
 *    bash scan. A Super Agent task runs the `claude-code` harness *inside a
 *    sandbox*, so Claude Code opens the PR in the pod and it passes through
 *    neither hook. Nothing linked it, so `enqueueReviewersOnThreadFinish` saw
 *    `prs.length === 0` and parked the card. Both this sweeper and
 *    `TASK_BOARD_ITEM_PRS_GET` papered over it by regexing a PR URL out of the
 *    run's closing message — which silently linked nothing whenever the model
 *    wrote "PR #269 opened" instead of the URL. `TASK_BOARD_ITEM_PR_LINK` (see
 *    `pr-link.ts`) replaced that guess: the run states its PR, so by the time a
 *    card reaches here it is already linked, and an unlinked card means the run
 *    genuinely opened no PR.
 *
 * 2. **The dispatch itself throws.** The projector's terminal hook runs inside a
 *    DBOS step, and the reviewer dispatch bottoms out in `enqueueThreadRun` →
 *    `DBOS.startWorkflow`, which DBOS rejects from a step:
 *    `DBOSInvalidWorkflowTransitionError` ("Invalid call to a `workflow`
 *    function from within a `step` or `transaction`", code 21). The per-reviewer
 *    `.catch` logged it and released the claim, so it retried and failed
 *    forever. Even a task WITH a linked PR never got a reviewer.
 *
 * A sweeper fixes both at once and is the only shape that can: it runs on a
 * boot-time timer, outside any workflow, so `startWorkflow` is legal here. It
 * also makes the pipeline self-healing — every card already stranded is picked
 * up on the next tick, with no backfill.
 *
 * Everything it calls is idempotent: `enqueueEnabledReviewers` claims per
 * (task, reviewer, cycle), so re-running every tick cannot spawn duplicate
 * reviewer runs.
 *
 * Idempotent is not the same as terminating, though, and conflating the two is
 * what took out the GitHub App's rate limit: a card whose checks never go green
 * never leaves `listItemsPendingReview`, so re-running was free of duplicate
 * REVIEWS but not free of duplicate GITHUB CALLS. Each card costs four
 * `pull_request_read` calls per sweep, and the sweep rate was this class's own
 * `setInterval` — per pod. 32 parked cards x 4 calls x 3 replicas / 60s held a
 * steady ~370 calls/min for 17 hours, 93% of them answered 429, until the pods
 * happened to restart. So the sweep budget now lives on the CARD
 * (`task_board_items.last_swept_at`, migration 166): replicas share it, and a
 * parked card costs one sweep per `DEFAULT_ITEM_SWEEP_INTERVAL_MS` instead of one
 * per tick. `DEFAULT_BATCH_SIZE` remains the ceiling on any single tick.
 *
 * Deliberately NOT a replacement for the instant paths. `TASK_BOARD_ITEM_PRS_GET`
 * dispatches reviewers on the dialog's poll, and the projector hook still fires —
 * the sweeper is the floor that guarantees it happens without a human, not the
 * only route.
 */

import type { StudioContextFactory } from "@/automations/fire";
import type { TaskBoardStorage } from "@/storage/task-board";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { enqueueEnabledReviewers } from "./enqueue-reviewer";
import { enqueueSuperAgentForTask } from "./enqueue-super-agent";
import { reactToFailedTaskRun } from "./run-reactions";
import { ABANDONED_FAILURE_REASON } from "./stall-recovery";
import { THREAD_EXPIRY_MS } from "@/tools/thread/helpers";
import { fetchPrLiveState, prReadyForReview } from "./prs-get";

/** How often to LOOK for due cards. A minute is well under the time a human
 *  would take to notice a stuck card, and the work list is one index scan when
 *  idle (`idx_task_board_items_pending_review`). This is not the rate a card is
 *  swept at — see `DEFAULT_ITEM_SWEEP_INTERVAL_MS`. */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

/** How often a single card may cost a GitHub round-trip (four
 *  `pull_request_read` calls). Five minutes, not the tick interval, because this
 *  sweeper is the floor rather than the fast path — the projector hook and the
 *  dialog poll still react immediately, so five minutes of extra latency on the
 *  recovery path is invisible next to the CI run the card waits on anyway. */
const DEFAULT_ITEM_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Items per tick. Bounds one tick's work: each item costs a `getById` and a
 *  GitHub round-trip per linked PR. Not a bound
 *  on what the sweep can reach — ticks page through the backlog with a keyset
 *  cursor (see `listItemsPendingReview`). */
const DEFAULT_BATCH_SIZE = 50;

/** How long to wait before retrying a retry whose DISPATCH threw (not the run —
 *  the enqueue itself). Short: nothing was spent, and the failure is usually a
 *  blip in the context factory or the quota read. */
const REARM_DELAY_MS = 60 * 1000;

/** How long a failed run may sit unreacted-to before the sweeper steps in. Long
 *  enough that the in-band reaction (which runs within milliseconds of the
 *  failure) always wins the normal case, short enough that a card whose pod died
 *  mid-reaction recovers on its own. */
const UNHANDLED_FAILURE_GRACE_MS = 2 * 60 * 1000;

export interface TaskBoardReviewSweeperOptions {
  intervalMs?: number;
  batchSize?: number;
  /** Minimum age of a card's last sweep before it is due again. */
  itemIntervalMs?: number;
}

export class TaskBoardReviewSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against a slow tick overlapping the next one — the batch is
   *  bounded but a cold GitHub call inside the reviewer dispatch is not. */
  private running = false;
  /** Where the last tick stopped, so the next one continues instead of
   *  re-scanning the same window. Null = start from the oldest card. */
  private cursor: { updatedAt: string; id: string } | null = null;

  constructor(
    private readonly taskBoard: TaskBoardStorage,
    private readonly contextFactory: StudioContextFactory,
    private readonly options: TaskBoardReviewSweeperOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, interval);
    this.timer.unref();
  }

  /** Exposed so tests can drive a single tick deterministically. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let dispatched = 0;
    try {
      const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
      const itemInterval =
        this.options.itemIntervalMs ?? DEFAULT_ITEM_SWEEP_INTERVAL_MS;
      const pending = await this.taskBoard.listItemsPendingReview(
        batchSize,
        this.cursor,
        new Date(Date.now() - itemInterval),
      );
      // A short page means the backlog is exhausted — wrap around so cards that
      // moved back into In Review behind the cursor get picked up again.
      const last = pending.at(-1);
      this.cursor =
        pending.length === batchSize && last
          ? { updatedAt: last.updatedAt, id: last.id }
          : null;
      for (const { id, organizationId } of pending) {
        // Best-effort per item: one card's failure must not stop the batch, or a
        // single wedged org would starve every other org's cards behind it.
        try {
          if (await this.reconcileItem(id, organizationId)) dispatched++;
        } catch (err) {
          console.error(`[task-board-review-sweeper] ${id} failed`, err);
        }
      }
      // Reap FIRST: a thread whose dispatch never landed reads as a live run to
      // every pass below (and to `reviewerHandledThisCycle`), so it has to become
      // `failed` before anything can react to it.
      await this.reapNeverStartedThreads(batchSize);
      dispatched += await this.dispatchDueRetries(batchSize);
      await this.reactToUnhandledFailures(batchSize);
    } catch (err) {
      console.error("[task-board-review-sweeper] sweep failed", err);
    } finally {
      this.running = false;
    }
    return dispatched;
  }

  /**
   * Fail task-linked threads whose run never started, headlessly and in BOTH
   * lanes.
   *
   * `recoverStalledTasks` already did this, but only on `TASK_BOARD_ITEM_LIST`
   * (so never without a human opening the board) and only for cards parked In
   * Progress — which left a REVIEWER thread whose dispatch never landed sitting
   * `in_progress` forever, read as a live review, blocking that reviewer's retry
   * for the rest of the cycle. Three of them did exactly that in one burst, on a
   * card whose PR was sitting there waiting for a verdict.
   *
   * Marking them failed is the whole fix: from there the existing reactions take
   * over — `reactToFailedTaskRun` retries a Super Agent thread, and a failed
   * reviewer attempt no longer counts as handled.
   */
  private async reapNeverStartedThreads(limit: number): Promise<void> {
    try {
      const reaped = await this.taskBoard.failNeverStartedLinkedThreads(
        limit,
        new Date(Date.now() - THREAD_EXPIRY_MS),
        ABANDONED_FAILURE_REASON,
      );
      for (const r of reaped) {
        console.warn(
          `[task-board-review-sweeper] failed never-started thread ` +
            `${r.threadId} on ${r.itemId}`,
        );
      }
    } catch (err) {
      console.error("[task-board-review-sweeper] reaping failed", err);
    }
  }

  /**
   * Run the failure reaction for cards whose reaction never ran.
   *
   * `reactToFailedTaskRun` fires on a terminal hook, so a pod that dies between
   * `markRunFailed` and that reaction leaves the card In Progress with a dead
   * run, no retry armed, and nothing else looking at it — now that a failed run
   * no longer advances to In Review, that would be a permanent strand. This is
   * the floor: the reaction is idempotent (it re-reads the card and both writes
   * are conditional on In Progress), so re-running it costs a query and fixes the
   * gap with no bookkeeping of its own.
   */
  private async reactToUnhandledFailures(limit: number): Promise<void> {
    const stuck = await this.taskBoard.listItemsStuckAfterFailure(
      limit,
      new Date(Date.now() - UNHANDLED_FAILURE_GRACE_MS),
    );
    for (const { id, organizationId, threadId } of stuck) {
      try {
        console.warn(
          `[task-board-review-sweeper] reacting to an unhandled failure on ${id}`,
        );
        await reactToFailedTaskRun(this.taskBoard, threadId, organizationId);
      } catch (err) {
        console.error(
          `[task-board-review-sweeper] unhandled-failure reaction for ${id} failed`,
          err,
        );
      }
    }
  }

  /**
   * Re-dispatch the cards whose infrastructure retry has come due
   * (`reactToFailedTaskRun` scheduled them on the row).
   *
   * It belongs on this timer for the same reason the reviewer dispatch does: the
   * failure hook that schedules a retry runs inside the projector's DBOS step,
   * where `DBOS.startWorkflow` is rejected. Out here it is legal, and
   * `enqueueSuperAgentForTask` puts the run on the durable thread-gate queue, so
   * DBOS owns the retry from that point on.
   *
   * `claimDueRetry` is a conditional clear of `retry_at`, so exactly one replica
   * dispatches a given retry however many pods are sweeping. Returns how many
   * runs it enqueued.
   */
  private async dispatchDueRetries(limit: number): Promise<number> {
    let count = 0;
    const due = await this.taskBoard.listItemsDueForRetry(limit, new Date());
    for (const { id, organizationId, attempts } of due) {
      try {
        if (
          !(await this.taskBoard.claimDueRetry(id, organizationId, new Date()))
        )
          continue;
        const item = await this.taskBoard.getById(id, organizationId);
        // Re-read before spending a run: a human may have moved or reassigned
        // the card between the scan and here, and their move wins.
        if (
          !item ||
          item.status !== "in_progress" ||
          item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID
        ) {
          continue;
        }
        const ctx = await this.contextFactory(
          organizationId,
          item.assignedBy ?? item.createdBy,
        );
        if (!ctx) continue;
        // A retry is work that already failed once and has a budget — it
        // outranks a brand-new task for the next slot.
        await enqueueSuperAgentForTask(ctx, item, { runClass: "retry" });
        count++;
        console.warn(
          `[task-board-review-sweeper] re-dispatched ${id} after a failure ` +
            `(attempt ${attempts})`,
        );
      } catch (err) {
        console.error(
          `[task-board-review-sweeper] retry dispatch for ${id} failed`,
          err,
        );
        // The claim already cleared `retry_at`, so leaving it here would spend
        // the attempt on a run that never started — the exact silent strand this
        // whole path exists to remove. Re-arm it instead: the dispatch itself can
        // fail on infrastructure (the context factory, the quota read), and that
        // deserves the same recovery as the run it was going to start. The
        // attempt counter is untouched, so the budget still terminates.
        await this.taskBoard
          .scheduleRunRetry(
            id,
            organizationId,
            attempts,
            new Date(Date.now() + REARM_DELAY_MS),
          )
          .catch((rearmErr) =>
            console.error(
              `[task-board-review-sweeper] re-arming ${id} failed`,
              rearmErr,
            ),
          );
      }
    }
    return count;
  }

  /** Hand a card with a linked, ready PR off to the enabled reviewers. Returns
   *  true when reviewers were considered (i.e. the card had a PR to review). */
  private async reconcileItem(
    id: string,
    organizationId: string,
  ): Promise<boolean> {
    const item = await this.taskBoard.getById(id, organizationId);
    if (!item) return false;
    // Re-check against the fresh row: `listItemsPendingReview` scanned a
    // possibly-stale snapshot, and a human can bounce/reassign the card between
    // that scan and this reconcile. Without this the sweeper would still
    // dispatch reviewers at a task that's no longer awaiting the Super Agent's
    // review — the same gate `TASK_BOARD_ITEM_PRS_GET` applies before its own
    // `enqueueEnabledReviewers` call.
    if (
      item.status !== "in_review" ||
      item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID
    ) {
      return false;
    }

    // Claim the interval BEFORE the GitHub work, not after: that is what makes a
    // second replica skip this card, and what stops a card that comes back
    // rate-limited from being retried on the very next tick. A pod crashing
    // mid-sweep costs one interval of delay — the right trade for a slow floor.
    await this.taskBoard.markSwept(id, organizationId);

    // Nothing to review without a PR — a research/answer task reaches In Review
    // too, and dispatching a reviewer at it would burn a run on nothing.
    const prs = await this.taskBoard.listPrs(id, organizationId);
    if (prs.length === 0) return false;

    // Built as the task's owner, like the run-finish trigger does — the sweeper
    // has storage only, and the reviewer dispatch needs a full context.
    const ctx = await this.contextFactory(
      organizationId,
      item.assignedBy ?? item.createdBy,
    );
    if (!ctx) return false;

    // Fetch live PR state (listPrs carries none) to tell an open PR from a
    // closed/merged one — the same candidate check the dialog poll applies.
    // Check status does NOT gate dispatch: reviewers run without waiting for CI
    // (see `prReadyForReview`); the merge is gated on green checks separately,
    // so nothing ships on red.
    const live = await Promise.all(
      prs.map(async (pr) => ({
        ...pr,
        ...(await fetchPrLiveState(ctx, organizationId, pr)),
      })),
    );
    // `fetchPrLiveState` is best-effort and yields ALL-NULL fields when the
    // GitHub call fails, which is indistinguishable from a PR whose state we
    // simply haven't got. `prReadyForReview` no longer treats that as "not
    // ready" (it used to, and a quiet GitHub then froze every card), but a whole
    // batch of unreadable PRs is still worth one line — otherwise a broken
    // GitHub connection is invisible from this side.
    if (live.every((pr) => pr.state === null)) {
      console.warn(
        `[task-board-review-sweeper] ${id}: no live PR state from GitHub ` +
          `(${live.length} PR(s)) — proceeding on unknown`,
      );
    }
    if (!prReadyForReview(live)) return false;

    await enqueueEnabledReviewers(ctx, item);
    return true;
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
