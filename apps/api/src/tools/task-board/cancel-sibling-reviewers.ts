import { cancelHostedHarness } from "@/dispatch-queue";
import { cancelThreadGateHead } from "@/dispatch-queue/thread-gate-queue";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  isReviewerThreadTitle,
  REVIEWER_KINDS,
  REVIEWER_LABEL,
  type ReviewerKind,
} from "@decocms/shared/task-board";

/**
 * The still-running reviewer threads that a `request_changes` decision should
 * cancel: every OTHER reviewer kind whose thread is currently `in_progress`.
 *
 * Scoped to `in_progress` on purpose. A sibling that finished (terminal) needs
 * no cancel, and one paused in `requires_action` is a genuine approval/user_ask
 * pause a human owns — leaving it matches `decideStallAction`'s stance and
 * `markRunFailed`'s `in_progress`-only flip (a requires_action row wouldn't flip
 * anyway). Restricting to OTHER kinds guarantees we never cancel the deciding
 * reviewer's own in-flight thread (which is running this very tool call).
 *
 * Pure — unit-tested.
 */
export function inProgressSiblingReviewerThreadIds(
  threads: { threadId: string; title: string | null; status: string | null }[],
  decidingReviewer: ReviewerKind,
): string[] {
  const otherKinds = REVIEWER_KINDS.filter((k) => k !== decidingReviewer);
  return threads
    .filter(
      (t) =>
        t.status === "in_progress" &&
        otherKinds.some((k) => isReviewerThreadTitle(t.title, k)),
    )
    .map((t) => t.threadId);
}

/**
 * A reviewer requested changes, so the task is bouncing back to the Super Agent
 * and this review cycle is abandoned. Any sibling reviewer still running is now
 * reviewing a stale PR — tear its run down so it can't record a decision for
 * code that's about to change, and so its thread goes terminal instead of
 * wedging `shouldAdvanceToReview` (which requires every linked thread terminal
 * before the fixed task can move back to In Review).
 *
 * Mirrors the durable, tool-reachable subset of `cancelActiveThreadRun`
 * (routes.ts): the durable cancel flag (ingest 409s the next step), the gate
 * head, and the hosted-harness child. The in-memory abort + NATS fan-out from
 * the route helper aren't reachable here, but a headless reviewer run has no SSE
 * tunnel; the durable path is what terminates it. Best-effort per thread — a
 * teardown hiccup must never fail the review decision itself.
 */
export async function cancelSiblingReviewerRuns(
  ctx: StudioContext,
  item: TaskBoardItem,
  decidingReviewer: ReviewerKind,
): Promise<void> {
  const organizationId = item.organizationId;
  const threadIds = inProgressSiblingReviewerThreadIds(
    item.threads,
    decidingReviewer,
  );
  for (const threadId of threadIds) {
    try {
      // Durable cancel flag: the ingest backstop rejects the sibling's next
      // step with 409, the documented correctness path.
      await ctx.storage.threads.setCancelRequested(threadId, organizationId);
      // Free a PENDING gate head so the concurrency=1 partition slot releases.
      await cancelThreadGateHead(threadId).catch(() => {});
      // Tear down the hosted-harness child so it can never later report success.
      const fence = await ctx.storage.threads.getRunFence(threadId);
      if (fence) {
        await cancelHostedHarness(threadId, fence).catch(() => {});
      }
      // Flip the thread terminal (in_progress → failed) so it stops counting as
      // live for the advance-to-review gate.
      await ctx.storage.threads.markRunFailed(
        threadId,
        `Superseded: ${REVIEWER_LABEL[decidingReviewer]} requested changes; this review cycle was abandoned.`,
        "cancelled",
      );
    } catch (err) {
      console.error("[task-board] failed to cancel sibling reviewer run", {
        taskBoardItemId: item.id,
        threadId,
        err,
      });
    }
  }
}
