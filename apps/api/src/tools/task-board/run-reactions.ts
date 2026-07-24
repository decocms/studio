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

import type { StudioContext } from "@/core/studio-context";
import { extractPrFromValue } from "./pr-extract";
import { reactToColumnEntry } from "./column-automation";
import { sseHub } from "@/event-bus/sse-hub";
import {
  TASK_BOARD_ITEM_DELETED_EVENT,
  TASK_BOARD_ITEM_UPDATED_EVENT,
} from "@decocms/shared/task-board";
import type { TaskBoardStorage } from "@/storage/task-board";
import type { TaskBoardItem, TaskBoardItemStatus } from "@/storage/types";

/** Canonical stage order — a run-driven transition only moves forward, never
 *  back. The tail stages (qa/ready_for_release/deploy) sit between review and
 *  done; nothing auto-advances into them (they're human/sync-driven), but the
 *  ranks keep a later human move from being clobbered by a late run event. */
const RANK: Record<TaskBoardItemStatus, number> = {
  triage: 0,
  todo: 1,
  in_progress: 2,
  in_review: 3,
  qa: 4,
  ready_for_release: 5,
  deploy: 6,
  done: 7,
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
async function resolveRunTaskTargets(
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
      // Timeline entry for the agent-driven move (actor "system"). Best-effort.
      await ctx.storage.taskBoard
        .recordActivity({
          organizationId: orgId,
          taskBoardItemId: itemId,
          kind: "status_changed",
          actorId: "system",
          data: { from: current.status, to: status },
        })
        .catch((err) =>
          console.error("[task-board] activity log write failed", err),
        );
      emitTaskBoardUpdated(orgId, item);
      // A run-driven advance can land in an automated column too (e.g. a QA
      // agent on In Review) — the automation stamp guards against loops.
      await reactToColumnEntry(ctx, item, {
        status: current.status,
        columnId: current.columnId,
      });
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
): Promise<void> {
  try {
    const moved = await taskBoard.advanceLinkedTasksToReviewOnThreadFinish(
      threadId,
      orgId,
    );
    for (const item of moved) emitTaskBoardUpdated(orgId, item);
  } catch (err) {
    console.error("[task-board] thread-finish transition failed", err);
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
