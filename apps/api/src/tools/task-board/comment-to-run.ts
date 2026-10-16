/**
 * A person's comment, carried to a Super Agent run: the words the run reads,
 * and the turn that delivers them to a run that already exists. Shared by the
 * comment tool (`mention-runs.ts`) and the fire's card step (`card-run.ts`).
 */

import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { nudgeThreadTurn } from "./nudge-thread";

/** A comment on its way to a run. */
export interface CommentForRun {
  commentId: string;
  body: string;
  authorId: string;
  authorName: string;
  /** The root of the comment thread the run answers in. */
  rootId: string;
}

/** The comment as the agent reads it: mentions as `@Name`, quoted. */
function quoted(body: string): string {
  return body
    .replace(/\[@([^\]]+)\]\(mention:[^)\s]+\)/g, "@$1")
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function replyHow(item: TaskBoardItem, rootId: string): string {
  return (
    "Post your progress and your result as replies to that comment: " +
    `TASK_BOARD_COMMENT_CREATE with taskBoardItemId "${item.id}", ` +
    `parentId "${rootId}" and audience "human".`
  );
}

/** What a run started by `comment` is told to do. */
export function mentionInstruction(
  item: TaskBoardItem,
  comment: CommentForRun,
): string {
  return (
    `${comment.authorName} mentioned you in a comment on this card:\n\n` +
    `${quoted(comment.body)}\n\nDo what they ask. ${replyHow(item, comment.rootId)}`
  );
}

/** Deliver `comment` to the run on `threadId` as its next user turn. */
export async function sendCommentToRun(
  ctx: StudioContext,
  item: TaskBoardItem,
  threadId: string,
  comment: CommentForRun,
): Promise<void> {
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread || thread.organization_id !== item.organizationId) {
    throw new Error("This run is no longer on the card.");
  }
  await nudgeThreadTurn(ctx, item, thread, {
    // One turn per comment, however many times the request is retried.
    messageId: `comment-${comment.commentId}`,
    workflowID: `comment:${comment.commentId}`,
    userId: comment.authorId,
    prompt:
      `${comment.authorName} wrote in this run's comment thread on the card:\n\n` +
      `${quoted(comment.body)}\n\n${replyHow(item, comment.rootId)}`,
  });
}
