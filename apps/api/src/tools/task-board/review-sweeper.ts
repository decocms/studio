/**
 * Periodic reconciler for Super Agent tasks parked In Review.
 *
 * It exists because the headless hand-off to the reviewers never worked, for two
 * independent reasons, and both are invisible from inside a DBOS workflow:
 *
 * 1. **The PR is never linked.** `linkPr` has exactly two callers:
 *    `capturePrForRun` and `TASK_BOARD_ITEM_PRS_GET`. The first is only
 *    reachable from the NATIVE Decopilot loop — the `onPrOpened` MCP wrapper and
 *    the `onStepFinish` bash scan. A Super Agent task runs the `claude-code`
 *    harness *inside a sandbox*, so Claude Code opens the PR in the pod and it
 *    passes through neither hook. Nothing links it, so
 *    `enqueueReviewersOnThreadFinish` sees `prs.length === 0` and parks the
 *    card. The web only calls `TASK_BOARD_ITEM_PRS_GET` from the task DIALOG, so
 *    the PR stayed invisible until a human opened that specific card.
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
 * Everything it calls is idempotent: `linkPr` is per (task, url), and
 * `enqueueEnabledReviewers` claims per (task, reviewer, cycle), so re-running
 * every tick cannot spawn duplicate reviewer runs.
 *
 * Deliberately NOT a replacement for the instant paths. `TASK_BOARD_ITEM_PRS_GET`
 * still does this on the dialog's poll, and the projector hook still fires — the
 * sweeper is the floor that guarantees it happens without a human, not the only
 * route.
 */

import type { StudioContextFactory } from "@/automations/fire";
import type { TaskBoardStorage } from "@/storage/task-board";
import { extractPrFromText } from "./pr-extract";
import { enqueueEnabledReviewers } from "./enqueue-reviewer";

/** How often to reconcile. A minute is well under the time a human would take
 *  to notice a stuck card, and the query is one indexed scan when idle. */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

/** Items per tick. Bounds one tick's work: each item costs a `getById`, up to
 *  one `linkPr` per thread, and an activity read inside the reviewer claim. */
const DEFAULT_BATCH_SIZE = 50;

export interface TaskBoardReviewSweeperOptions {
  intervalMs?: number;
  batchSize?: number;
}

export class TaskBoardReviewSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against a slow tick overlapping the next one — the batch is
   *  bounded but a cold GitHub call inside the reviewer dispatch is not. */
  private running = false;

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
      const pending = await this.taskBoard.listItemsPendingReview(
        this.options.batchSize ?? DEFAULT_BATCH_SIZE,
      );
      for (const { id, organizationId } of pending) {
        // Best-effort per item: one card's failure must not stop the batch, or a
        // single wedged org would starve every other org's cards behind it.
        try {
          if (await this.reconcileItem(id, organizationId)) dispatched++;
        } catch (err) {
          console.error(`[task-board-review-sweeper] ${id} failed`, err);
        }
      }
    } catch (err) {
      console.error("[task-board-review-sweeper] sweep failed", err);
    } finally {
      this.running = false;
    }
    return dispatched;
  }

  /** Link any PR the run left in its closing message, then hand off to the
   *  enabled reviewers. Returns true when reviewers were considered (i.e. the
   *  card had a PR to review). */
  private async reconcileItem(
    id: string,
    organizationId: string,
  ): Promise<boolean> {
    const item = await this.taskBoard.getById(id, organizationId);
    if (!item) return false;

    // Same recovery `TASK_BOARD_ITEM_PRS_GET` does: the agent's closing summary
    // reliably prints the URL ("Opened PR #309 https://github.com/…/pull/309").
    // Idempotent per (task, url).
    for (const thread of item.threads) {
      const pr = thread.lastMessage
        ? extractPrFromText(thread.lastMessage)
        : null;
      if (!pr) continue;
      await this.taskBoard.linkPr({
        taskBoardItemId: id,
        organizationId,
        url: pr.url,
        prNumber: pr.number,
        repoOwner: pr.owner,
        repoName: pr.repo,
        connectionId: null,
      });
    }

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

    // Deliberately NOT gated on the PR's live check status, unlike the dialog
    // poll: that gate costs a GitHub round-trip per PR per tick, and a card
    // whose checks are still pending simply gets picked up on a later tick.
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
