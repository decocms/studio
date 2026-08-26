/**
 * "A reviewer that reviewed and said nothing on the card" — closed
 * deterministically.
 *
 * What production actually showed (14 days, prod RDS) is three failures wearing
 * one shape, and only one of them needs a model:
 *
 * 1. **The Code Reviewer wasn't silent — it wrote in the wrong place.** 244 of
 *    408 completed runs left no comment, while its verdicts carry ~2,000
 *    characters of review in `notes`, which the timeline renders as ONE
 *    truncated `text-xs` line. Its prompt never asked for a comment, so it used
 *    the only channel it had. Paying for a second agent run to retype text we
 *    already have would be absurd: `mirrorVerdictAsComment` copies it into the
 *    comment feed, no model involved.
 * 2. **QA that couldn't screenshot.** 8 of the 9 QA runs with no embedded image
 *    had explained why in prose — in Portuguese, or as "no styling delta", or
 *    "this PR has no deploy preview". Prose is not the answer, though: "no
 *    visual regressions" is what a UI run that FORGOT its screenshots writes,
 *    and any pattern loose enough to accept a real justification accepts that
 *    too. Hence the `NO_VISUAL_SURFACE` sentinel — one literal, checked
 *    exactly, in every language.
 * 3. **A run that ended mid-intent.** One QA run spent 2h51m, captured its
 *    screenshots, said "Recording the QA pass." and hit its cap: no comment and
 *    no verdict. Nothing here can help that one — it never called the decision
 *    tool, which is where this hook lives. It belongs to the existing
 *    `reviewerAttemptsExhausted` → hand-to-human path.
 *
 * So the guarantee splits by cost. The RECORD is deterministic and free: any
 * verdict whose run left no comment is mirrored into one. The one thing a model
 * must produce — QA's before/after screenshots — gets a single follow-up turn on
 * the reviewer's OWN thread, so its Claude Code session (and everything it just
 * verified) is still in context.
 *
 * `TASK_BOARD_REVIEW_DECISION` is the right home for both: it is the moment a
 * reviewer's work is provably done, and unlike the projector's finish hook it
 * runs outside a DBOS step, so it can start a workflow (see
 * `review-sweeper.ts`).
 *
 * At most one DISPATCH, ever: the message id and the run `workflowID` are both
 * derived from the reviewer's thread id, so the persisted turn is idempotent and
 * DBOS collapses a second enqueue. Nothing retries the run itself if it fails;
 * the gap is logged when detected. The mirror is idempotent for a different
 * reason — it re-reads the comments first, so a repeated decision call finds the
 * comment it just wrote.
 */

import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  NO_VISUAL_SURFACE,
  REVIEWER_LABEL,
  SUPER_AGENT_ASSIGNEE_ID,
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
  return own.some((c) => hasVisualEvidence(c.body)) ? null : "no_screenshots";
}

/** Does this one comment carry the visual evidence QA owes? `![` opens a
 *  markdown image either side of `embedOrgOutputImages`. Pure — unit-tested. */
export function hasVisualEvidence(body: string): boolean {
  return body.includes("![") || body.includes(NO_VISUAL_SURFACE);
}

/**
 * What's still owed right after mirroring the verdict notes into a comment —
 * checked directly against that one comment, NOT through `reviewerCommentGap`.
 * The mirrored text IS the reviewer's definitive record regardless of length
 * (a one-word "LGTM" verdict is still a real verdict, not a progress note),
 * so re-applying `MIN_RECORD_LENGTH` here would keep flagging a short-but-real
 * code-review approval as "missing" forever and send it the QA-only
 * screenshots follow-up meant for a different reviewer kind entirely.
 */
export function nextGapAfterMirror(
  kind: ReviewerKind,
  mirroredBody: string,
): ReviewerCommentGap | null {
  if (kind !== "qa") return null;
  return hasVisualEvidence(mirroredBody) ? null : "no_screenshots";
}

/** The mirrored comment's body: the reviewer's own verdict text, headed by which
 *  reviewer said it and what it decided. Pure — unit-tested. */
export function verdictCommentBody(
  kind: ReviewerKind,
  decision: "approve" | "request_changes",
  notes: string,
): string {
  const verb = decision === "approve" ? "approved" : "requested changes";
  return `**${REVIEWER_LABEL[kind]}** ${verb}:\n\n${notes.trim()}`;
}

/** The follow-up turn, for the one gap a model has to close: QA captured (or
 *  failed to capture) screenshots, and only it can put them on the card. */
function followUpPrompt(kind: ReviewerKind): string {
  return [
    `Your ${REVIEWER_LABEL[kind]} comment carries no screenshots and does not declare the change free of any visual surface. One of the two is required — a QA pass on a visual change nobody can SEE is not a QA pass.`,
    "",
    "Do exactly ONE thing in this run and then stop:",
    "- Post a comment with `TASK_BOARD_COMMENT_CREATE` carrying the before/after screenshots you captured, embedded as markdown images referencing their `org/output/...` path, each pair in a two-column table.",
    "- If the change genuinely has none, or you could not capture it (no deploy preview, the page would not render), write the exact words `" +
      NO_VISUAL_SURFACE +
      "` in the comment instead, followed by one sentence naming why. That literal is what the check looks for — no paraphrase and no translation of it counts.",
    "- Do NOT re-run the review, do NOT call `TASK_BOARD_REVIEW_DECISION` again (your verdict is already recorded), and do NOT change any code.",
    "- If you have already posted such a comment, do nothing and say so.",
  ].join("\n");
}

/**
 * Guarantee this reviewer's run left a readable record on the card, and ask for
 * the one artifact only a model can produce.
 *
 * `threadId` is the reviewer run's thread (from the task-run MCP context). A
 * decision recorded outside a run — a human calling the tool — has none, and
 * nothing to mirror or follow up on.
 */
export async function ensureReviewerCommented(
  ctx: StudioContext,
  item: TaskBoardItem,
  kind: ReviewerKind,
  threadId: string,
  verdict: { decision: "approve" | "request_changes"; notes: string },
): Promise<void> {
  const comments = await ctx.storage.taskBoard.listComments(
    item.id,
    item.organizationId,
  );
  let gap = reviewerCommentGap(comments, threadId, kind);
  if (!gap) return;

  // The record itself costs nothing — the reviewer already wrote it, into the
  // one channel the timeline truncates. Move it where it renders.
  if (gap === "missing") {
    const body = verdictCommentBody(kind, verdict.decision, verdict.notes);
    await ctx.storage.taskBoard.createComment({
      taskBoardItemId: item.id,
      organizationId: item.organizationId,
      // Same author id the agent's own comments carry, so the UI renders it as
      // the agent without a second concept; the thread id is what attributes it
      // to THIS reviewer's run.
      authorId: SUPER_AGENT_ASSIGNEE_ID,
      threadId,
      body,
    });
    console.warn(
      `[task-board] ${kind} reviewer on ${item.id} recorded no comment — ` +
        `mirrored its verdict notes`,
    );
    // A mirrored verdict is a record, but for QA it is not evidence.
    gap = nextGapAfterMirror(kind, body);
    if (!gap) return;
  }

  const thread = await ctx.storage.threads.get(threadId);
  // Only a v2 thread can take a new turn — dispatch nulls the part emitter for
  // v1, so the follow-up would run with nothing persisted and nothing rendered
  // (same gate as `decideStallAction`).
  if (!thread || thread.message_storage_version !== 2) return;

  console.warn(
    `[task-board] qa reviewer on ${item.id} showed no visual evidence — ` +
      `asking for it`,
  );
  await nudgeThreadTurn(ctx, item, thread, {
    messageId: `review-comment-${threadId}`,
    prompt: followUpPrompt(kind),
    // The fence: one follow-up per reviewer run, however many times a decision
    // is recorded (a reviewer that doesn't recognise the tool result as
    // terminal calls it twice).
    workflowID: `review-comment:${threadId}`,
    // A verdict already landed; this is the last thing between the card and a
    // human being able to see what was verified.
    runClass: "reviewer",
    // No reviewer `instructions` on purpose: they would ask for a second review.
    agent: { disallowedTools: REVIEWER_DISALLOWED_TOOLS[kind] },
  });
}
