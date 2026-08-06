/**
 * Super Agent run → task board status reactions.
 *
 * A task delegated to the Super Agent rides its run's lifecycle:
 *   enqueued            → todo         (create/update tool, synchronous)
 *   loop starts         → in_progress  (runHostedHarness)
 *   agent opens a PR    → in_review    (github MCP tool call OR bash `gh pr create`)
 *   thread finishes,    → in_review    (projector terminal → thread-finish hook)
 *     no repo loaded
 *   user re-prompts a   → in_progress  (runHostedHarness, thread-run hook)
 *     reviewed task
 *
 * The last two are LINK-based (`task_board_item_threads`), not runMetadata-based,
 * so they hold for a re-prompted thread that carries no run metadata.
 *
 * The PR-open path resolves the item from `ctx.metadata.runMetadata.taskBoardItemId`
 * (set at enqueue) first, falling back to the same thread link when that's absent —
 * so a repo-backed task's SECOND PR, opened after a re-prompt, still lands In Review.
 * Each transition also pushes the updated item over SSE for a real-time board.
 */

import { releaseTaskExecution } from "@/billing/task-quota";
import type { OrganizationBillingStorage } from "@/storage/organization-billing";
import { TERMINAL_THREAD_STATUSES } from "@/storage/task-board";
import type { StudioContext } from "@/core/studio-context";
import { extractPrFromValue } from "./pr-extract";
import { retryBudgetFor } from "./transient-failure";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import { sseHub } from "@/event-bus/sse-hub";
import {
  TASK_BOARD_ITEM_DELETED_EVENT,
  TASK_BOARD_ITEM_UPDATED_EVENT,
} from "@decocms/shared/task-board";
import type { TaskBoardStorage } from "@/storage/task-board";
import type { TaskBoardItem, TaskBoardItemStatus } from "@/storage/types";

/** Board lane order — a transition only moves a card forward, never back. */
const RANK: Record<TaskBoardItemStatus, number> = {
  triage: 0,
  todo: 1,
  in_progress: 2,
  in_review: 3,
  done: 4,
};

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
 * Advance the run's linked task board item(s) forward to `status` and
 * broadcast each move. Resolves the linked item(s) from `runMetadata` first
 * (set at enqueue for the task's own run), falling back to the
 * `task_board_item_threads` link by `threadId` — the fallback is what makes
 * this fire for a re-prompted, repo-backed task's second PR, which carries no
 * run metadata. No-op when neither resolves, when an item is gone, or when
 * the target status wouldn't move its card forward. Best-effort: a failure
 * here never disturbs the agent run.
 */
export async function advanceTaskBoardForRun(
  ctx: StudioContext,
  status: TaskBoardItemStatus,
  threadId?: string,
): Promise<void> {
  const orgId = ctx.organization?.id;
  if (!orgId) return;
  try {
    for (const itemId of await resolveRunTaskTargets(ctx, orgId, threadId)) {
      const current = await ctx.storage.taskBoard.getById(itemId, orgId);
      // ponytail: read-then-write rank guard. A single run's transitions are
      // sequential, so the race window is negligible; it buys idempotency (a
      // repeated PR tool call, or in_progress re-fired on a DBOS retry, won't
      // regress a card that's already further along). Upgrade to a conditional
      // UPDATE ... WHERE status-rank < new-rank only if concurrency ever bites.
      if (!current || RANK[status] <= RANK[current.status]) continue;
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
    }
  } catch (err) {
    console.error("[task-board] run transition failed", err);
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
    for (const item of moved) emitTaskBoardUpdated(orgId, item);
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
      if (!item || item.status !== "in_progress") continue;
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
              from: "in_progress",
              to: "in_progress",
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
            from: "in_progress",
            to: "todo",
            reason: failure.errorText ?? failure.kind,
            retriesSpent: attempts,
          },
        })
        .catch(() => {});
      emitTaskBoardUpdated(orgId, returned);
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
async function refundUnproductiveTaskClaims(
  taskBoard: TaskBoardStorage,
  billing: OrganizationBillingStorage,
  threadId: string,
  orgId: string,
): Promise<void> {
  try {
    for (const taskId of await taskBoard.linkedTaskIds(threadId, orgId)) {
      const item = await taskBoard.getById(taskId, orgId);
      if (!item) continue;
      if (RANK[item.status] >= RANK.in_review) continue;
      const stillRunning = item.threads.some(
        (t) =>
          t.hasMessages &&
          (t.status === null || !TERMINAL_THREAD_STATUSES.has(t.status)),
      );
      if (stillRunning) continue;
      if ((await taskBoard.listPrs(taskId, orgId)).length > 0) continue;
      await releaseTaskExecution(billing, orgId, taskId);
    }
  } catch (err) {
    console.error("[task-board] quota refund pass failed", err);
  }
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
