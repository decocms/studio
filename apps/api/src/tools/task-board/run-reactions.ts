/**
 * Super Agent run → task board status reactions.
 *
 * A task delegated to the Super Agent rides its run's lifecycle:
 *   enqueued            → todo          (create/update tool, synchronous)
 *   loop starts         → in_progress    (runHostedHarness)
 *   agent opens a PR    → review cycle   (github MCP tool call OR bash `gh pr create`)
 *                         opens, lane
 *                         stays in_progress
 *   thread finishes,    → in_review      (projector terminal → thread-finish hook)
 *     no repo loaded
 *   reviewer decides    → in_review      (`parkReviewedCardForHuman`)
 *   user re-prompts a   → in_progress    (runHostedHarness, thread-run hook)
 *     reviewed task
 *
 * A PR does NOT move the card. Since migration 190 the review cycle is a column
 * (`review_cycle_started_at`), not a lane, so an agent reviewer can work on a
 * card that still truthfully reads In Progress; In Review is reserved for "it
 * is a person's turn". `inReviewPhase` is the predicate that spans both.
 *
 * The link-based transitions use `task_board_item_threads`, not runMetadata, so
 * they hold for a re-prompted thread that carries no run metadata. The PR-open
 * path resolves the item from `ctx.metadata.runMetadata.taskBoardItemId` (set at
 * enqueue) first, falling back to the same thread link when that's absent — so a
 * repo-backed task's SECOND PR, opened after a re-prompt, still opens a cycle.
 * Each transition also pushes the updated item over SSE for a real-time board.
 */

import { releaseTaskExecution, TaskQuotaError } from "@/billing/task-quota";
import { captureOrgEvent } from "@/posthog";
import type { OrganizationBillingStorage } from "@/storage/organization-billing";
import { TERMINAL_THREAD_STATUSES } from "@/storage/task-board";
import type { StudioContext } from "@/core/studio-context";
import { extractPrFromValue } from "./pr-extract";
import { invalidatePrCards } from "./prs-get";
import { retryBudgetFor } from "./transient-failure";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import { sseHub } from "@/event-bus/sse-hub";
import {
  isReportsTask,
  LANES,
  SUPER_AGENT_ASSIGNEE_ID,
  TASK_BOARD_ITEM_DELETED_EVENT,
  TASK_BOARD_ITEM_UPDATED_EVENT,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { LANE_RANK, inReviewPhase, laneRank, atOrBefore } from "./lanes";
import type { TaskBoardStorage } from "@/storage/task-board";
import type { TaskBoardItem } from "@/storage/types";

/** Run-lifecycle funnel events (auto-fix leg of the PLG funnel). System
 *  actions with no acting user — org identity, person processing off.
 *  Fire-and-forget; posthog no-ops without POSTHOG_KEY. */
function captureTaskRunEvent(
  event: "task_run_started" | "task_run_completed" | "task_run_failed",
  orgId: string,
  item: Pick<TaskBoardItem, "id" | "createdBy">,
  properties?: Record<string, unknown>,
): void {
  captureOrgEvent({
    event,
    organizationId: orgId,
    properties: {
      task_id: item.id,
      reports_task: isReportsTask(item),
      ...properties,
    },
  });
}

/** Push a task board item change to every SSE listener on its org. */
export function emitTaskBoardUpdated(orgId: string, item: TaskBoardItem): void {
  sseHub.emit(orgId, {
    id: crypto.randomUUID(),
    type: TASK_BOARD_ITEM_UPDATED_EVENT,
    source: "task-board",
    subject: item.id,
    data: item,
    time: new Date().toISOString(),
  });
}

/** Push a task board item deletion to every SSE listener on its org. */
export function emitTaskBoardDeleted(orgId: string, itemId: string): void {
  sseHub.emit(orgId, {
    id: crypto.randomUUID(),
    type: TASK_BOARD_ITEM_DELETED_EVENT,
    source: "task-board",
    subject: itemId,
    data: { id: itemId },
    time: new Date().toISOString(),
  });
}

/**
 * Which task item(s) a run-driven advance targets: the enqueue-set
 * `runMetadata.taskBoardItemId` when present (the task's own dispatched run),
 * else the thread's `task_board_item_threads` link rows. Metadata wins over
 * the link — it never unions the two, so the task's own run advances exactly
 * its item, and only a metadata-less re-prompt falls back to the link. Pure so
 * the fallback decision is unit-tested without a StudioContext.
 */
export function resolveAdvanceTargets(
  metadataItemId: string | undefined,
  linkedIds: string[],
): string[] {
  return metadataItemId ? [metadataItemId] : linkedIds;
}

/**
 * The task board item(s) a run-driven side effect targets: the enqueue-set
 * `runMetadata.taskBoardItemId` when present, else the thread's link rows. The
 * thread link is queried only on the fallback path (no metadata + a threadId).
 * Shared by the advance-status and PR-capture reactions so both resolve a
 * subtask-opened action the same way.
 */
export async function resolveRunTaskTargets(
  ctx: StudioContext,
  orgId: string,
  threadId?: string,
): Promise<string[]> {
  const metadataItemId = ctx.metadata?.runMetadata?.taskBoardItemId;
  const linkedIds =
    !metadataItemId && threadId
      ? await ctx.storage.taskBoard.linkedTaskIds(threadId, orgId)
      : [];
  return resolveAdvanceTargets(metadataItemId, linkedIds);
}

/**
 * Advance the run's linked task board item(s) forward to this board's `lane` and
 * broadcast each move. Resolves the linked item(s) from `runMetadata` first
 * (set at enqueue for the task's own run), falling back to the
 * `task_board_item_threads` link by `threadId` — the fallback is what makes
 * this fire for a re-prompted, repo-backed task's second PR, which carries no
 * run metadata. No-op when neither resolves, when this board has no column for
 * `lane`, when an item is gone, or when the target wouldn't move the card
 * forward. Best-effort: a failure
 * here never disturbs the agent run.
 */
export async function advanceTaskBoardForRun(
  ctx: StudioContext,
  lane: keyof typeof LANES,
  threadId?: string,
): Promise<void> {
  const orgId = ctx.organization?.id;
  if (!orgId) return;
  try {
    const status = LANES[lane];
    for (const itemId of await resolveRunTaskTargets(ctx, orgId, threadId)) {
      const current = await ctx.storage.taskBoard.getById(itemId, orgId);
      if (!current) continue;
      // Read-then-write guard, by lane order. A single run's transitions are
      // sequential, so the race window is negligible; it buys idempotency — a
      // repeated PR tool call, or a run start re-fired on a DBOS retry, must
      // not drag a card that is already further right back to this lane.
      if (current.status === status || !atOrBefore(current.status, status)) {
        continue;
      }
      const item = await ctx.storage.taskBoard.update(
        itemId,
        orgId,
        { status },
        ctx.auth?.user?.id ?? current.updatedBy,
      );
      // Timeline entry for the agent-driven move — no human actor, hence null.
      // Best-effort.
      await ctx.storage.taskBoard
        .recordActivity({
          taskBoardItemId: itemId,
          action: "status_changed",
          actorId: null,
          data: { from: current.status, to: status },
        })
        .catch((err) =>
          console.error("[task-board] activity log write failed", err),
        );
      emitTaskBoardUpdated(orgId, item);
      // The PR-open hook no longer comes through here — it opens a review
      // cycle instead (`openReviewCycleForRun`) and emits its own event — so
      // the only advance left to report is the run starting.
      if (lane === "progress") {
        captureTaskRunEvent("task_run_started", orgId, item, {
          from: current.status,
        });
      }
    }
  } catch (err) {
    console.error("[task-board] run transition failed", err);
  }
}

/**
 * A run opened a GitHub PR — open the review cycle on its linked task(s).
 *
 * This is the real-time trigger: the card gets a reviewer the moment the PR
 * exists, mid-run, rather than waiting for the thread-finish backstop. It does
 * NOT move the card — an agent is still the one working on it, so it stays In
 * Progress until a verdict lands (`parkReviewedCardForHuman`).
 *
 * Idempotent by construction: `openReviewCycleIfInProgress` only stamps a card
 * that has no cycle open, so a run that opens two PRs, or a tool hook that
 * fires twice, cannot move a boundary that already has verdicts behind it.
 * Best-effort — a failure here never disturbs the agent run.
 */
export async function openReviewCycleForRun(
  ctx: StudioContext,
  threadId?: string,
): Promise<void> {
  const orgId = ctx.organization?.id;
  if (!orgId) return;
  try {
    for (const itemId of await resolveRunTaskTargets(ctx, orgId, threadId)) {
      const opened = await ctx.storage.taskBoard.openReviewCycleIfInProgress(
        itemId,
        orgId,
      );
      if (!opened) continue;
      emitTaskBoardUpdated(orgId, opened);
      captureTaskRunEvent("task_run_completed", orgId, opened, {
        from: "in_progress",
        via: "pr_open",
      });
    }
  } catch (err) {
    console.error("[task-board] review-cycle open failed", err);
  }
}

/**
 * A run opened a GitHub PR — extract its identity from `source` (an MCP
 * `create_pull_request` result or a `bash` tool's output) and link it to the
 * run's task board item(s). Resolves the target(s) the same way as the status
 * advance (runMetadata first, else the thread link), so a PR opened inside a
 * subtask (which carries no metadata but shares the thread) still links.
 * Idempotent per (task, url) at the storage layer; best-effort — a failure
 * never disturbs the agent run. No-op when no PR URL is found or off a task run.
 */
export async function capturePrForRun(
  ctx: StudioContext,
  source: unknown,
  connectionId?: string | null,
  threadId?: string,
): Promise<void> {
  const orgId = ctx.organization?.id;
  if (!orgId) return;
  try {
    const pr = extractPrFromValue(source);
    if (!pr) return;
    const targets = await resolveRunTaskTargets(ctx, orgId, threadId);
    for (const itemId of targets) {
      await ctx.storage.taskBoard.linkPr({
        taskBoardItemId: itemId,
        organizationId: orgId,
        url: pr.url,
        prNumber: pr.number,
        repoOwner: pr.owner,
        repoName: pr.repo,
        connectionId: connectionId ?? null,
      });
    }
    // Drop the cached cards so a viewer's next poll shows the new PR, not a stale "no PR" placeholder.
    if (targets.length > 0) await invalidatePrCards(orgId);
  } catch (err) {
    console.error("[task-board] PR capture failed", err);
  }
}

/**
 * A run reached a terminal status on `threadId` — advance any linked repo-less
 * task whose threads have all finished to In Review, and broadcast each move.
 * Best-effort: a failure here never disturbs the projector. Takes the storage
 * directly (not a StudioContext) so the projector runtime can call it.
 */
export async function advanceTasksToReviewOnThreadFinish(
  taskBoard: TaskBoardStorage,
  threadId: string,
  orgId: string,
  /** Quota bookkeeping (billing/task-quota.ts). Required on purpose: an
   *  optional arg here is a silent way for a caller to stop refunding. */
  billing: OrganizationBillingStorage,
): Promise<void> {
  try {
    const moved = await taskBoard.advanceLinkedTasksToReviewOnThreadFinish(
      threadId,
      orgId,
    );
    for (const item of moved) {
      emitTaskBoardUpdated(orgId, item);
      captureTaskRunEvent("task_run_completed", orgId, item, {
        from: "in_progress",
        via: "thread_finish",
      });
    }
    for (const item of moved) {
      // The card produced something, so the next unrelated failure gets a full
      // retry budget rather than inheriting this card's history.
      await taskBoard.clearRunRetry(item.id, orgId).catch(() => {});
    }
  } catch (err) {
    console.error("[task-board] thread-finish transition failed", err);
  }
  await reactToFailedTaskRun(taskBoard, threadId, orgId);
  await refundUnproductiveTaskClaims(taskBoard, billing, threadId, orgId);
}

/**
 * True when a card has demonstrably produced something a person can look at:
 * it reached In Review or beyond, or it is still In Progress with a review
 * cycle open — which since migration 190 is exactly where a card sits while an
 * agent reviews its pull request.
 *
 * Rank alone used to answer this, and would now read a card mid-review as
 * having delivered nothing: it would refund its own quota claim and relabel a
 * lost stream as a plain failure.
 */
function cardDelivered(item: {
  status: string;
  reviewCycleStartedAt: string | null;
}): boolean {
  return (
    (laneRank(item.status) ?? -1) >= LANE_RANK.in_review ||
    Boolean(item.reviewCycleStartedAt)
  );
}

/** The per-failure retry budget lives in `transient-failure.ts`
 *  (`retryBudgetFor`): the full budget for recognized infrastructure, one
 *  benefit-of-the-doubt attempt for anything unrecognized, none for a
 *  deliberate cancel. */

/** Backoff between retries. The failure we retry is capacity, so the wait has to
 *  be long enough for capacity to actually return (a sandbox readiness timeout
 *  is itself 180s) — 30s, 60s, 120s, with jitter so eight cards that failed
 *  together don't re-dispatch in lockstep and recreate the burst that broke
 *  them. */
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 120_000;

/** Recorded on a run that lost its stream after it had already delivered. */
const DELIVERED_FAILURE_REASON =
  "Run ended after it had already delivered — the task moved on without it";

/**
 * A task's run failed — decide between a retry and the board.
 *
 * `In Review` is not an option: it means "there is something to review", and a
 * failed run left nothing. So an infrastructure failure (see
 * `isTransientRunFailure`) keeps the card In Progress and schedules a
 * re-dispatch on the row (`retry_at`), which the review sweeper drains — the
 * schedule has to survive a pod restart, and it cannot be a `DBOS.startWorkflow`
 * from here because this runs inside the projector's DBOS step, which rejects
 * starting a workflow (`DBOSInvalidWorkflowTransitionError`, code 21 — the same
 * constraint that put the reviewer dispatch in the sweeper). The re-dispatch
 * itself goes through `enqueueAgentRunForTask` onto the durable thread-gate
 * queue, so DBOS owns the run from there.
 *
 * Anything else — an error the agent produced, or a card out of retries — goes
 * back to To Do with the reason on its timeline, where a human sees it.
 *
 * Best-effort throughout: this is a terminal hook, and a failure to react must
 * never fail the run that already ended.
 */
export async function reactToFailedTaskRun(
  taskBoard: TaskBoardStorage,
  threadId: string,
  orgId: string,
): Promise<void> {
  try {
    const failure = await taskBoard.failedRunInfo(threadId, orgId);
    if (!failure) return;
    const budget = retryBudgetFor(failure);
    for (const itemId of await taskBoard.linkedTaskIds(threadId, orgId)) {
      const item = await taskBoard.getById(itemId, orgId);
      if (!item) continue;
      // The run moved the card itself and only THEN lost its stream. By rank, so
      // a card the merged-PR reconcile pushed further still counts as delivered
      // — as does one still In Progress with a review cycle open, which since
      // migration 190 is what a card with a PR under review looks like.
      if (cardDelivered(item)) {
        await taskBoard
          .relabelDeliveredFailure(threadId, orgId, DELIVERED_FAILURE_REASON)
          .catch(() => {});
      }
      if (item.status !== LANES.progress) continue;
      // A REVIEWER's run failed, not the author's: the card is In Progress only
      // because that is where a card under review sits now. Retrying it here
      // would dispatch a fresh Super Agent run over a PR that is waiting for a
      // verdict, or park a reviewed card back on To Do. The reviewer has its
      // own budget (`spentAttemptsThisCycle`), and the sweeper spends it.
      if (item.reviewCycleStartedAt) continue;
      // Another of this card's threads is still working — its outcome decides
      // the card, not this one's.
      if (
        item.threads.some((t) => t.hasMessages && t.status === "in_progress")
      ) {
        continue;
      }
      const attempts = item.retryAttempts;
      if (attempts < budget) {
        const delay = exponentialBackoffWithJitter(
          RETRY_CAP_MS,
          RETRY_BASE_MS,
          attempts,
          2,
          0.5,
        );
        const scheduled = await taskBoard.scheduleRunRetry(
          itemId,
          orgId,
          attempts + 1,
          new Date(Date.now() + delay),
        );
        if (!scheduled) continue;
        await taskBoard
          .recordActivity({
            taskBoardItemId: itemId,
            action: "status_changed",
            actorId: null,
            data: {
              from: LANES.progress,
              to: LANES.progress,
              retry: attempts + 1,
              of: budget,
              reason: failure.errorText ?? failure.kind,
            },
          })
          .catch(() => {});
        continue;
      }
      const returned = await taskBoard.returnToTodoAfterFailure(
        itemId,
        orgId,
        item.updatedBy,
      );
      if (!returned) continue;
      await taskBoard
        .recordActivity({
          taskBoardItemId: itemId,
          action: "status_changed",
          actorId: null,
          data: {
            from: LANES.progress,
            to: LANES.queue,
            reason: failure.errorText ?? failure.kind,
            retriesSpent: attempts,
          },
        })
        .catch(() => {});
      emitTaskBoardUpdated(orgId, returned);
      captureTaskRunEvent("task_run_failed", orgId, item, {
        reason: failure.kind ?? "error",
        retries_spent: attempts,
      });
    }
  } catch (err) {
    console.error("[task-board] failed-run reaction failed", err);
  }
}

/**
 * The ONE place a task-quota charge is refunded (billing/task-quota.ts): a
 * finished run whose task demonstrably produced nothing.
 *
 * All three conditions are DURABLE FACTS, never "did we observe an event":
 *  - no linked pull request — the immutable proof of output, whatever lane the
 *    card sits in (status is user-writable, so it can't be the discriminator);
 *  - the card never reached In Review — a repo-less task's answer IS its
 *    deliverable, and that transition is how the board records one;
 *  - no other used thread on the task is still running — a task gets a fresh
 *    thread per dispatch, so a sibling finishing must never refund a run
 *    that's still spending.
 *
 * Anything unproven leaves the claim charged, which is the safe direction: a
 * path that never reports its outcome (claude-code, a human dragging the card,
 * stall recovery) costs the customer their execution rather than costing us an
 * unbilled one.
 */
export async function refundUnproductiveTaskClaims(
  taskBoard: TaskBoardStorage,
  billing: OrganizationBillingStorage,
  threadId: string,
  orgId: string,
): Promise<void> {
  try {
    for (const taskId of await taskBoard.linkedTaskIds(threadId, orgId)) {
      const item = await taskBoard.getById(taskId, orgId);
      if (!item) continue;
      if (cardDelivered(item)) continue;
      const stillRunning = item.threads.some(
        (t) =>
          t.hasMessages &&
          (t.status === null || !TERMINAL_THREAD_STATUSES.has(t.status)),
      );
      if (stillRunning) continue;
      if ((await taskBoard.listPrs(taskId, orgId)).length > 0) continue;
      // task_quota_refunded is emitted inside releaseTaskExecution, gated on
      // the release actually transitioning a held claim.
      await releaseTaskExecution(billing, orgId, taskId);
    }
  } catch (err) {
    console.error("[task-board] quota refund pass failed", err);
  }
}

/**
 * The agent side of a review is over — move the card into In Review, where a
 * person picks it up.
 *
 * This is the OTHER half of migration 190. A card whose reviewer is still
 * running reads In Progress, because that is the truthful thing to say while an
 * agent is working; In Review means "it is your turn". Something has to make
 * that second transition, and it is this: every terminal of the review —
 * a verdict, an exhausted retry budget, a hand-off — comes through here.
 *
 * A no-op unless the card is actually mid-cycle In Progress, so it can neither
 * drag a card backward out of a delivery lane nor re-park one a human already
 * moved. The cycle stays OPEN (In Review is inside the review phase), which is
 * what keeps the verdict that just landed valid.
 *
 * Best-effort: never fail a verdict over the lane it lands in.
 */
export async function parkReviewedCardForHuman(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<void> {
  if (item.status !== LANES.progress || !inReviewPhase(item)) return;
  try {
    const parked = await ctx.storage.taskBoard.update(
      item.id,
      item.organizationId,
      { status: LANES.review },
      item.updatedBy,
    );
    await ctx.storage.taskBoard
      .recordActivity({
        taskBoardItemId: item.id,
        action: "status_changed",
        actorId: null,
        data: { from: item.status, to: LANES.review },
      })
      .catch(() => {});
    emitTaskBoardUpdated(item.organizationId, parked);
  } catch (err) {
    console.error(`[task-board] parking ${item.id} for review failed`, err);
  }
}

/**
 * Stop automating a card and hand it to a person, with the reason on its
 * timeline.
 *
 * Every automatic lane out of In Review can dead-end: the reviewer's approval
 * didn't verify, its runs burned their attempts, the run parked a card there
 * with no PR to review. Each of those used to `return` silently — the card kept
 * being swept, kept costing GitHub calls, and read on the board exactly like a
 * card whose reviewers were still thinking. Twelve of them accumulated in one
 * org, the oldest for a week.
 *
 * Unassigning is what makes it terminal AND idempotent: every automatic path
 * (the sweeper's `reconcileItem`, the reviewer dispatch, the conflict reaction)
 * requires the Super Agent as assignee, so a handed-over card is visited once
 * and then left alone. Deliberately leaves the STATUS untouched — In Review is
 * where a human wants to pick a reviewed card up, and moving it would lose the
 * reviewers' notes' context — `parkReviewedCardForHuman` is what settles the
 * lane, and it runs first here so a handed-off card never reads as still being
 * worked on. Returns true when this call did the handover.
 */
export async function handTaskToHuman(
  ctx: StudioContext,
  item: TaskBoardItem,
  reason: string,
): Promise<boolean> {
  const orgId = item.organizationId;
  if (item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) return false;
  try {
    // Best-effort: parking needs to know the board, and a card must still
    // reach a person when that read fails.
    await parkReviewedCardForHuman(ctx, item).catch((err) =>
      console.warn(
        `[task-board] parking ${item.id} before hand-off failed`,
        err,
      ),
    );
    // Re-checks the assignee against the DB, not this stale `item`.
    const handed = await ctx.storage.taskBoard.unassignSuperAgent(
      item.id,
      orgId,
      item.updatedBy,
    );
    if (!handed) return false;
    await recordTaskActivity(ctx, {
      taskBoardItemId: item.id,
      action: "assignee_changed",
      actorId: null,
      data: { from: item.assigneeId, to: null, reason },
    });
    console.warn(`[task-board] ${item.id} handed to a human: ${reason}`);
    emitTaskBoardUpdated(orgId, handed);
    return true;
  } catch (err) {
    console.error(`[task-board] handing ${item.id} to a human failed`, err);
    return false;
  }
}

/**
 * The per-task run cap (`maxRunsPerTask`) refused an AUTOMATIC re-dispatch, so
 * nothing will run on this task again on its own. Hand it to a human saying so.
 *
 * Without this the refusal is invisible: `runs_exhausted` throws out of
 * `enqueueSuperAgentForTask` into a log line, and the state machine keeps
 * cycling on a PR that never gains a commit. Four prod cards sat like that —
 * reviewers re-reviewed an untouched PR five times over ninety minutes and the
 * board's only explanation was "the reviewer and the Super Agent are not
 * converging". They HAD converged; the agent was never dispatched.
 *
 * Narrow to `runs_exhausted` on purpose. The other quota reasons are org-wide
 * paywalls that existing callers deliberately surface to the user; only the
 * per-task cap is a dead end that a card can neither report nor escape (a human
 * Re-run is exempt from it, which is exactly the action this hand-off asks for).
 *
 * Returns true when it handled `err` — the caller must then stop treating the
 * dispatch as pending. False for any other error, which the caller still owns.
 */
export async function parkOnRunsExhausted(
  ctx: StudioContext,
  item: TaskBoardItem,
  err: unknown,
): Promise<boolean> {
  if (!(err instanceof TaskQuotaError)) return false;
  if (err.reason !== "runs_exhausted") return false;
  await handTaskToHuman(
    ctx,
    item,
    "per-task run limit reached — the Super Agent can no longer re-dispatch " +
      "itself on this task. Re-run it manually to continue.",
  );
  return true;
}

/**
 * A run is starting on `threadId` — pull any linked task back from In Review to
 * In Progress and broadcast it. Best-effort; no-ops off a task thread.
 */
export async function reopenTasksOnThreadRun(
  ctx: StudioContext,
  threadId: string,
): Promise<void> {
  const orgId = ctx.organization?.id;
  if (!orgId) return;
  try {
    const moved = await ctx.storage.taskBoard.reopenLinkedTasksOnThreadRun(
      threadId,
      orgId,
    );
    for (const item of moved) emitTaskBoardUpdated(orgId, item);
  } catch (err) {
    console.error("[task-board] thread-run reopen failed", err);
  }
}

/**
 * True when an MCP tool call opens a GitHub PR. Matched by substring so a
 * gateway-prefixed name (`conn-6-..._create_pull_request`) still counts.
 */
export function isPrCreateMcpTool(toolName: string): boolean {
  return (
    toolName.includes("create_pull_request") ||
    toolName.includes("createPullRequest")
  );
}

// ponytail: heuristics for the bash escape hatch. Agents open PRs from bash two
// ways — `gh pr create`, or a raw `curl -X POST …/repos/…/pulls` when gh / the
// GitHub-MCP tool is unavailable (observed in prod: the MCP connection was scoped
// to the wrong repo → the agent fell back to curl). Known ceiling: misses shell
// aliases and script wrappers. The reliable path is the MCP tool above.
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/;
const GITHUB_API_PULLS = /api\.github\.com\/repos\/[^\s"']+\/pulls\b/;
const HTTP_POST = /(?:-X|--request)\s+POST/;

/** True when a bash command opens a GitHub PR (gh CLI or a REST POST to /pulls). */
export function isPrCreateBashCommand(command: string): boolean {
  if (GH_PR_CREATE.test(command)) return true;
  return GITHUB_API_PULLS.test(command) && HTTP_POST.test(command);
}
