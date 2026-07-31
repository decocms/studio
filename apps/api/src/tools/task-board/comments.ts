/**
 * Comments on a task — the discussion threads in the task dialog's activity
 * feed. One level of replies (a reply's parent is always a thread root), a
 * resolved flag per thread, and `@`-mentions of members, other tasks, and the
 * Super Agent.
 *
 * Mentioning the Super Agent hands the question to it: the create tool enqueues
 * a run on the task, pins the comment on the run (`runMetadata`) so the run gets
 * a `reply_comment` built-in bound to it, and remembers the run thread on the
 * comment. The agent replies with that tool, as often as it has something to
 * say. A mention arriving while a run is already working the task is NOT a
 * second run: the live run reads new comments at its next step boundary
 * (`task-comment-feed.ts`). Whatever it leaves unanswered when the run ends,
 * `postAgentCommentReplyOnThreadFinish` (`run-reactions.ts`) answers with its
 * final message — so a mention always gets at least one reply, while an
 * unmentioned comment is just context it may ignore.
 *
 * Mentioning a *member* only records the mention — there is no notification
 * system to hand it to yet.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import type {
  TaskBoardComment,
  TaskBoardCommentMention,
} from "@/storage/types";
import {
  SUPER_AGENT_ASSIGNEE_ID,
  TaskBoardCommentMentionSchema,
  TaskBoardCommentSchema,
} from "./schema";
import { enqueueSuperAgentForTask } from "./enqueue-super-agent";
import {
  emitTaskCommentAgentTyping,
  emitTaskCommentCreated,
} from "./run-reactions";

/** A comment the agent hasn't answered yet, as the prompt renders it. */
type CommentBacklogEntry = {
  id: string;
  authorName: string;
  body: string;
  mentions: TaskBoardCommentMention[];
};

/**
 * Everything said since the agent last spoke, oldest first, with mentions
 * flagged. Answering only the newest comment is what made it look like it
 * ignored people, so the backlog is spelled out and the obligation with it: a
 * mention needs an answer, an unmentioned comment may be read and skipped.
 *
 * Falls back to the triggering comment alone if the backlog read came back empty
 * (it shouldn't — that comment is in it — but a turn with no question in it is
 * worse than a duplicated one).
 */
function formatBacklog(
  backlog: CommentBacklogEntry[],
  trigger: TaskBoardComment,
): string {
  const entries = backlog.length
    ? backlog
    : [
        {
          id: trigger.id,
          authorName: "Someone",
          body: trigger.body,
          mentions: trigger.mentions,
        },
      ];

  const lines = entries.map((c) => {
    const mentioned = mentionsSuperAgent(c.mentions);
    return [
      `- ${c.authorName}${mentioned ? " (mentions you — needs a reply)" : ""} [comment_id: ${c.id}]`,
      c.body
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    ].join("\n");
  });

  return [
    entries.length > 1
      ? "Comments on this task you haven't answered yet, oldest first — cover ALL of them, and don't claim you can't see one that's listed here:"
      : "Comment:",
    ...lines,
  ].join("\n");
}

/** The org of the calling context, or a hard error — comments are org-scoped
 *  through their task. */
function requireOrg(ctx: StudioContext): string {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

/** True when a comment hands its question to the Super Agent. */
function mentionsSuperAgent(mentions: TaskBoardCommentMention[]): boolean {
  return mentions.some(
    (m) => m.kind === "user" && m.id === SUPER_AGENT_ASSIGNEE_ID,
  );
}

export const TASK_BOARD_COMMENT_LIST = defineTool({
  name: "TASK_BOARD_COMMENT_LIST",
  description:
    "List a task board item's comments (flat, oldest first; `parentId` null marks a thread root).",
  annotations: {
    title: "List Task Comments",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: z.object({ comments: z.array(TaskBoardCommentSchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const comments = await ctx.storage.taskBoard.listComments(
      input.taskBoardItemId,
      requireOrg(ctx),
    );
    return { comments };
  },
});

export const TASK_BOARD_COMMENT_CREATE = defineTool({
  name: "TASK_BOARD_COMMENT_CREATE",
  description:
    "Comment on a task board item, or reply to an existing comment thread. Mentioning the Super Agent starts a run on the task and its answer is posted back as a reply.",
  annotations: {
    title: "Create Task Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    body: z.string().min(1),
    parentId: z
      .string()
      .nullable()
      .optional()
      .describe("The thread root to reply to. Omit to start a new thread."),
    mentions: z.array(TaskBoardCommentMentionSchema).optional(),
  }),
  outputSchema: z.object({ comment: TaskBoardCommentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);

    const mentions = input.mentions ?? [];
    const comment = await ctx.storage.taskBoard.createComment({
      taskBoardItemId: input.taskBoardItemId,
      organizationId,
      parentId: input.parentId ?? null,
      authorId: getUserId(ctx)!,
      body: input.body,
      mentions,
    });
    // Every open dialog on this task appends it live, including the poster's
    // other tabs — the composer doesn't have to guess what the server stored.
    emitTaskCommentCreated(organizationId, comment);

    if (mentionsSuperAgent(mentions)) {
      // Show the agent as typing from the moment the run is dispatched; the
      // thread-finish hook clears it.
      emitTaskCommentAgentTyping(organizationId, {
        taskBoardItemId: comment.taskBoardItemId,
        threadRootId: comment.parentId ?? comment.id,
        typing: true,
      });
      await dispatchSuperAgentForComment(ctx, organizationId, comment).catch(
        (err) => {
          // The comment is already persisted, so a dispatch failure (e.g. no
          // model configured) must never fail the comment that asked — but the
          // indicator has to come back down, since no run will clear it.
          console.error(
            "[task-board] comment Super Agent dispatch failed",
            err,
          );
          emitTaskCommentAgentTyping(organizationId, {
            taskBoardItemId: comment.taskBoardItemId,
            threadRootId: comment.parentId ?? comment.id,
            typing: false,
          });
        },
      );
    }

    return { comment };
  },
});

export const TASK_BOARD_COMMENT_UPDATE = defineTool({
  name: "TASK_BOARD_COMMENT_UPDATE",
  description:
    "Edit a comment's body (author only) or resolve/unresolve a comment thread (any member).",
  annotations: {
    title: "Update Task Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    body: z.string().min(1).optional(),
    resolved: z
      .boolean()
      .optional()
      .describe("Thread roots only — a thread settles as a whole."),
  }),
  outputSchema: z.object({ comment: TaskBoardCommentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);

    const current = await ctx.storage.taskBoard.getComment(
      input.id,
      organizationId,
    );
    if (!current) throw new Error(`Comment not found: ${input.id}`);
    // Anyone on the task can settle a thread; only the author rewrites words.
    if (input.body !== undefined && current.authorId !== getUserId(ctx)) {
      throw new Error("Only the author can edit a comment");
    }

    const comment = await ctx.storage.taskBoard.updateComment(
      input.id,
      organizationId,
      { body: input.body, resolved: input.resolved },
    );
    if (!comment) throw new Error(`Comment not found: ${input.id}`);
    return { comment };
  },
});

export const TASK_BOARD_COMMENT_DELETE = defineTool({
  name: "TASK_BOARD_COMMENT_DELETE",
  description: "Delete a comment and its replies.",
  annotations: {
    title: "Delete Task Comment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);

    const current = await ctx.storage.taskBoard.getComment(
      input.id,
      organizationId,
    );
    if (!current) return { success: false };
    // Own comments only. A null author is the Super Agent's — no member owns
    // those, so any member on the task may clear one.
    if (current.authorId !== null && current.authorId !== getUserId(ctx)) {
      throw new Error("Only the author can delete a comment");
    }

    const success = await ctx.storage.taskBoard.deleteComment(
      input.id,
      organizationId,
    );
    return { success };
  },
});

/**
 * Hand a comment to the Super Agent.
 *
 * One thread per task, reused for every mention: the first one opens it, each
 * later comment is another turn on the same thread. That's what keeps the
 * conversation coherent (it remembers what was already said) and what makes a
 * mention arriving mid-run land — the thread gate queues the turn behind the
 * running one instead of dropping it or forking a second agent.
 */
async function dispatchSuperAgentForComment(
  ctx: StudioContext,
  organizationId: string,
  comment: TaskBoardComment,
): Promise<void> {
  const task = await ctx.storage.taskBoard.getById(
    comment.taskBoardItemId,
    organizationId,
  );
  if (!task) return;

  const existing = await ctx.storage.taskBoard.commentConversationThread(
    task.id,
    organizationId,
  );
  // Everything said since the agent's last word, not just the comment that
  // triggered this turn: a comment with no mention starts no run of its own, so
  // this is the only place it can reach the agent.
  const backlog = await ctx.storage.taskBoard.unansweredCommentBacklog(
    task.id,
    organizationId,
  );
  const newest = backlog[backlog.length - 1]?.createdAt;

  const threadId = await enqueueSuperAgentForTask(ctx, task, {
    prompt: existing
      ? followUpPrompt(backlog, comment)
      : firstMentionPrompt(task, backlog, comment),
    runMetadata: {
      taskBoardCommentId: comment.id,
      // The mid-run feed starts after what the prompt already carries, so a
      // comment isn't shown twice.
      ...(newest ? { taskBoardCommentsSince: newest } : {}),
    },
    // A comment run isn't a work session on the card — see `enqueueSuperAgentForTask`.
    linkThread: false,
    threadId: existing ?? undefined,
  });

  // ponytail: written after the enqueue, so a run that both starts AND finishes
  // in the time this UPDATE takes would find no comment to reply to. The queue
  // pickup plus a model round-trip make that window unreachable in practice;
  // if it ever bites, thread the comment id into the enqueue instead.
  await ctx.storage.taskBoard.setCommentAgentThread(comment.id, threadId);
}

/**
 * The opening turn of a task's comment conversation. Tuned from observed runs:
 * told only that its answer would be posted for it, the agent went hunting for
 * a way to post and delegated a whole subtask agent to do it; and asked a design
 * question, it burned five failing sandbox calls before answering something it
 * knew already. Hence the explicit tools, reply-first, and no-retry rules.
 */
function firstMentionPrompt(
  task: { id: string; title: string; description: string | null },
  backlog: CommentBacklogEntry[],
  comment: TaskBoardComment,
): string {
  return [
    "You were mentioned in a comment on this task. Answer it with the `reply_comment` tool.",
    "",
    `Task: ${task.title}`,
    task.description ? `\nDescription:\n${task.description}\n` : "",
    formatBacklog(backlog, comment),
    "",
    "How to reply:",
    "- Use `reply_comment`: it posts under the comment for you — never hand the posting to another agent.",
    "- Reply FIRST, investigate second. If the task, the comment, and what you already know are enough to answer — a greeting, an opinion, a design question, anything conversational — call `reply_comment` as your very first action and stop. Reading files or running commands before answering just makes the person wait.",
    "- Only open files or run commands when the comment asks you to do or check something you genuinely can't answer without them.",
    "- If a tool errors, that tool is done for this run: do not call it again, and do not reach for a sibling tool to route around the same broken thing (a failing sandbox breaks bash, grep, glob and read alike). One failure, then stop touching it.",
    "- When you're blocked on something only a person can clear — a decision, a credential, broken infrastructure — say so once with `reply_comment` and then call `user_ask` with the question. That parks the run as needing attention instead of ending quietly as if the work were done. Don't keep retrying and don't report the same failure twice.",
    "- You can reply more than once (say, an answer now and a finding later), but don't spam the thread: no acknowledgements, no progress narration, no repeating yourself. One reply is usually right.",
    "- Keep it short and answer only what the comment asks. If it's just a greeting, greet back in one line and name the obvious next step on this task.",
    "- If the comment asks you to actually start the work, say so with `reply_comment` AND move the card with `set_task_status` (`in_progress`) — the board doesn't move itself just because you're talking. Then do the work. Don't move the card for a conversation.",
    "- People may comment again while you work; you'll be shown those. Every one that mentions you needs a reply before you finish.",
    "",
    `(task id: ${task.id})`,
  ].join("\n");
}

/** A later comment on a task whose conversation thread already exists — the
 *  rules are in this thread's history, so this turn stays short. */
function followUpPrompt(
  backlog: CommentBacklogEntry[],
  comment: TaskBoardComment,
): string {
  return [
    formatBacklog(backlog, comment),
    "",
    "Answer it with `reply_comment`, same rules as before: reply first, investigate only if it asks for work, and if it asks you to start, move the card with `set_task_status` (`in_progress`) before you begin.",
    "If a tool is still failing, don't grind on it: reply once and call `user_ask` so a person picks it up.",
  ].join("\n");
}
