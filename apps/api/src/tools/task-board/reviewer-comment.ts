/**
 * "A reviewer that reviewed and said nothing on the card" — closed
 * deterministically.
 *
 * The reviewer prompts ask for a task comment recording the pass, and QA's asks
 * for the before/after screenshots inside it. A prompt is not a guarantee: runs
 * in production reached a verdict and left the card with no record of what was
 * checked, which is the one artifact a human reading the board actually needs.
 *
 * So the verdict path checks it. `TASK_BOARD_REVIEW_DECISION` is the moment a
 * reviewer's work is provably done, and it runs outside any DBOS step (unlike
 * the projector's finish hook, which cannot start a workflow — see
 * `review-sweeper.ts`), so a follow-up run can be dispatched from there. The
 * follow-up is one more user turn on the reviewer's OWN thread, so its Claude
 * Code session — and everything it just verified — is still in context; it asks
 * for the comment and nothing else.
 *
 * At most one DISPATCH, ever: the message id and the run `workflowID` are both
 * derived from the reviewer's thread id, so the persisted turn is idempotent and
 * DBOS collapses a second enqueue. Nothing retries the run itself if it fails;
 * the gap is logged when detected, and the existing hand-to-human paths own a
 * reviewer that won't cooperate.
 */

import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  NO_VISUAL_SURFACE,
  REVIEWER_LABEL,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { nudgeThreadTurn } from "./nudge-thread";
import { REVIEWER_DISALLOWED_TOOLS } from "./enqueue-reviewer";

/** What the reviewer still owes the card. Null = nothing. */
export type ReviewerCommentGap = "missing" | "no_screenshots";

/** A comment short enough to be a progress note ("starting review, loading the
 *  PR") rather than the record the card needs. */
const MIN_RECORD_LENGTH = 80;

/**
 * What this reviewer's run failed to record on the card. Pure — unit-tested.
 *
 * Attribution is `threadId`: every agent comment carries the same synthetic
 * author id, so the run's own thread is the only thing that separates the QA
 * Agent's comment from the Code Reviewer's from the Super Agent's.
 */
export function reviewerCommentGap(
  comments: readonly { threadId: string | null; body: string }[],
  threadId: string,
  kind: ReviewerKind,
): ReviewerCommentGap | null {
  const own = comments.filter(
    (c) => c.threadId === threadId && c.body.trim().length >= MIN_RECORD_LENGTH,
  );
  if (own.length === 0) return "missing";
  if (kind !== "qa") return null;
  // `![` opens a markdown image either side of `embedOrgOutputImages`.
  const shown = own.some((c) => c.body.includes("!["));
  const justified = own.some((c) => c.body.includes(NO_VISUAL_SURFACE));
  return shown || justified ? null : "no_screenshots";
}

function followUpPrompt(kind: ReviewerKind, gap: ReviewerCommentGap): string {
  const lines = [
    gap === "missing"
      ? `You recorded your ${REVIEWER_LABEL[kind]} verdict but posted NO comment on the task. The verdict alone tells the humans reading the board nothing about what you checked.`
      : `Your ${REVIEWER_LABEL[kind]} comment carries no screenshots and does not declare the change free of any visual surface. One of the two is required.`,
    "",
    "Do exactly ONE thing in this run and then stop:",
    gap === "missing"
      ? "- Post a comment with `TASK_BOARD_COMMENT_CREATE` recording the review you just did — the scenarios / criteria you checked with a pass/fail on each, the exact URL(s) and viewport where applicable, and anything you could not verify and why. Do NOT re-run the review; write down what you already found."
      : "- Post a comment with `TASK_BOARD_COMMENT_CREATE` carrying the before/after screenshots you captured, embedded as markdown images referencing their `org/output/...` path, each pair in a two-column table. If the change genuinely has none, write the exact words `" +
        NO_VISUAL_SURFACE +
        "` in the comment instead, followed by one sentence naming why (backend-only, config, test-only).",
    "- Do NOT call `TASK_BOARD_REVIEW_DECISION` again; your verdict is already recorded.",
    "- Do NOT change any code.",
    "- If you have already posted such a comment, do nothing and say so.",
  ];
  return lines.join("\n");
}

/**
 * Make sure this reviewer's run left its record on the card; dispatch one
 * comment-only follow-up turn on its own thread if it didn't.
 *
 * `threadId` is the reviewer run's thread (from the task-run MCP context). A
 * decision recorded outside a run — a human calling the tool — has none, and
 * nothing to follow up on.
 */
export async function ensureReviewerCommented(
  ctx: StudioContext,
  item: TaskBoardItem,
  kind: ReviewerKind,
  threadId: string,
): Promise<void> {
  const comments = await ctx.storage.taskBoard.listComments(
    item.id,
    item.organizationId,
  );
  const gap = reviewerCommentGap(comments, threadId, kind);
  if (!gap) return;

  const thread = await ctx.storage.threads.get(threadId);
  // Only a v2 thread can take a new turn — dispatch nulls the part emitter for
  // v1, so the follow-up would run with nothing persisted and nothing rendered
  // (same gate as `decideStallAction`).
  if (!thread || thread.message_storage_version !== 2) return;

  console.warn(
    `[task-board] ${kind} reviewer on ${item.id} left no ` +
      `${gap === "missing" ? "comment" : "screenshots"} — asking for one`,
  );
  await nudgeThreadTurn(ctx, item, thread, {
    messageId: `review-comment-${threadId}`,
    prompt: followUpPrompt(kind, gap),
    // The fence: one follow-up per reviewer run, however many times a decision
    // is recorded (a reviewer that doesn't recognise the tool result as
    // terminal calls it twice).
    workflowID: `review-comment:${threadId}`,
    // A verdict already landed; this is the last thing between the card and a
    // human being able to read what happened.
    runClass: "reviewer",
    // No reviewer `instructions` on purpose: they would ask for a second review.
    agent: { disallowedTools: REVIEWER_DISALLOWED_TOOLS[kind] },
  });
}
