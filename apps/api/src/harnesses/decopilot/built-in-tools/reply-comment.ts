/**
 * `reply_comment` — answer a task-board comment from inside the run it started.
 *
 * Registered ONLY when the run carries `runMetadata.taskBoardCommentId` (set by
 * `TASK_BOARD_COMMENT_CREATE` when a comment `@`-mentions the Super Agent), so
 * it can't be reached from an ordinary chat. The originating comment and the task
 * are bound in the closure: `comment_id` is optional and defaults to the comment
 * that started the run, and any id the model does pass is checked against the
 * bound task — so it can answer a comment that arrived mid-run (those carry
 * their ids in the injected activity block) but can never post onto another
 * task's thread.
 *
 * Why it exists: told only that its final message would be posted as the reply,
 * the agent went looking for a way to post it and delegated a whole subtask
 * agent to do the posting. A tool it can actually call removes the guesswork.
 * Replying more than once is allowed — a conversation is a back-and-forth — and
 * the run-end net (`finishCommentRun`) only covers mentions it left unanswered.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import {
  emitTaskCommentAgentTyping,
  emitTaskCommentCreated,
} from "@/tools/task-board/run-reactions";

const ReplyCommentInputSchema = z.object({
  body: z
    .string()
    .min(1)
    .describe("The reply, as the person who commented will read it."),
  comment_id: z
    .string()
    .optional()
    .describe(
      "Omit to reply to the comment that started this run. Pass the id of another comment on this task (they appear in new-comment blocks) to answer that one instead.",
    ),
});

export function createReplyCommentTool(
  ctx: StudioContext,
  binding: { threadId: string; commentId: string; taskBoardItemId: string },
) {
  return tool({
    description:
      "Reply to a task board comment. Defaults to the comment that started this run, so you normally pass only a body. You may call this more than once — reply again when you have something new to say (an answer, a finding, a question), not to acknowledge or narrate progress. Never hand the posting to another agent.",
    inputSchema: zodSchema(ReplyCommentInputSchema),
    execute: async ({ body, comment_id }) => {
      const organizationId = ctx.organization?.id;
      if (!organizationId) return { posted: false, reason: "no organization" };

      const outcome = await ctx.storage.taskBoard.replyToCommentAsAgent({
        threadId: binding.threadId,
        organizationId,
        taskBoardItemId: binding.taskBoardItemId,
        commentId: comment_id ?? binding.commentId,
        body,
      });
      if (!outcome)
        return { posted: false, reason: "no such comment on this task" };
      if (!outcome.comment) return { posted: false, reason: "write failed" };

      emitTaskCommentCreated(organizationId, outcome.comment);
      // The reply is up, so the thread stops showing the agent as typing even
      // though the run may keep going.
      emitTaskCommentAgentTyping(organizationId, {
        taskBoardItemId: outcome.taskBoardItemId,
        threadRootId: outcome.threadRootId,
        typing: false,
      });

      return { posted: true, commentId: outcome.comment.id };
    },
  });
}
