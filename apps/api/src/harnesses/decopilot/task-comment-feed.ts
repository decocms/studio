/**
 * Mid-run task comment feed.
 *
 * A run working on a task board item shouldn't be deaf to what people say while
 * it works: comments written after the run started are handed to the model as a
 * user turn at the next step boundary (`pendingContext` → `prepareStep`).
 *
 * The step boundary IS the sync point — the poll runs from `onStepFinish`, one
 * indexed query per step. Deliberately not driven by the SSE hub: a query at the
 * boundary can't miss a comment (no subscription to establish, nothing to replay
 * after a pod hand-off), and "before the next turn" is exactly a step boundary,
 * so an earlier wake-up would buy nothing — the model isn't listening between
 * steps anyway.
 *
 * It never holds the loop for long: the wait is capped at `POLL_BUDGET_MS`, and
 * a slower query isn't cancelled or lost — it lands in the shared array and the
 * following step picks it up. One poll is in flight at a time, so a slow one
 * can't double-read the same window.
 */

import { sleep } from "@decocms/shared/std";
import type { StudioContext } from "@/core/studio-context";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

/** How long a step boundary will wait on the comment read before moving on. */
const POLL_BUDGET_MS = 1_500;

export interface TaskCommentFeed {
  /** Poll once and push any new activity into `sink`. Bounded; never throws. */
  pollInto(sink: string[]): Promise<void>;
}

/**
 * A feed for the run's linked task, or null when this run isn't working on one
 * (`runMetadata.taskBoardItemId` is set by the task-board dispatch paths).
 *
 * `since` starts at run assembly: the comment that triggered the run is already
 * in the prompt, so the feed only ever carries what came after.
 */
export function createTaskCommentFeed(
  ctx: StudioContext,
): TaskCommentFeed | null {
  const taskBoardItemId = ctx.metadata?.runMetadata?.taskBoardItemId;
  const organizationId = ctx.organization?.id;
  if (!taskBoardItemId || !organizationId) return null;

  let since = new Date().toISOString();
  let inFlight: Promise<void> | null = null;

  const read = async (sink: string[]) => {
    const comments = await ctx.storage.taskBoard.listCommentsSince(
      taskBoardItemId,
      organizationId,
      since,
    );
    if (comments.length === 0) return;
    // Advance only on a successful read, so a timed-out poll re-reads the same
    // window instead of skipping it.
    since = comments[comments.length - 1]!.createdAt;
    sink.push(formatNewComments(comments));
  };

  return {
    async pollInto(sink) {
      if (inFlight) return;
      inFlight = read(sink)
        .catch((err) => {
          console.error("[task-board] mid-run comment poll failed", err);
        })
        .finally(() => {
          inFlight = null;
        });
      await Promise.race([inFlight, sleep(POLL_BUDGET_MS)]);
    },
  };
}

/**
 * The user turn the model sees. Mentions are called out explicitly — an
 * unmentioned comment is context it may ignore, a mention is something it owes
 * an answer — and each comment carries its id so `reply_comment` can address the
 * right thread.
 */
export function formatNewComments(
  comments: {
    id: string;
    authorName: string;
    body: string;
    mentions: { kind: string; id: string }[];
  }[],
): string {
  const lines = comments.map((c) => {
    const mentioned = c.mentions.some(
      (m) => m.kind === "user" && m.id === SUPER_AGENT_ASSIGNEE_ID,
    );
    return [
      `- ${c.authorName}${mentioned ? " (mentions you)" : ""} [comment_id: ${c.id}]`,
      c.body
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    ].join("\n");
  });

  return [
    "<new-task-comments>",
    "People commented on this task while you were working. Keep going with what you were doing; this is context, not a new instruction.",
    "Every comment that mentions you needs a `reply_comment` (pass its comment_id) before you finish — answer it once you can say something useful. The rest you may read and ignore.",
    "",
    ...lines,
    "</new-task-comments>",
  ].join("\n");
}
