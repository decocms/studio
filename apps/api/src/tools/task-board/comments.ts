/**
 * Comments on a task — threads in the task dialog's activity feed, one level of
 * replies deep. Create/update/delete ship together; the list tool is flat and
 * the UI nests by `parentId`.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { taskCommentAttachmentPaths } from "@decocms/shared/task-comment-attachments";
import {
  deleteAttachmentFiles,
  orphanedCommentAttachments,
} from "./comment-attachments";
import { uploadsAsSandboxPaths } from "./description-uploads";
import { taskRunContextStore } from "./task-run-context";

/** No real comment is this long — caps the row a single POST can write. */
const MAX_COMMENT_BODY_LENGTH = 50_000;

const TaskBoardCommentSchema = z.object({
  id: z.string(),
  taskBoardItemId: z.string(),
  /** Null on a thread root; a reply points at its root. */
  parentId: z.string().nullable(),
  authorId: z.string(),
  /** Source run, when this comment was written by an agent. */
  threadId: z.string().nullable().optional(),
  body: z.string(),
  /** Thread roots only — a thread is settled or open as a whole. */
  resolved: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function requireOrg(ctx: StudioContext): string {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

/**
 * Delete the attachment files that `removed` comment bodies linked to and
 * nothing the task keeps — `keptComments` and its description — still mentions.
 */
async function deleteOrphanedAttachments(
  ctx: StudioContext,
  task: { id: string; organizationId: string },
  removed: string[],
  keptComments: string[],
): Promise<void> {
  if (
    !removed.some((body) => taskCommentAttachmentPaths(body, task.id).length)
  ) {
    return;
  }
  const item = await ctx.storage.taskBoard.getById(
    task.id,
    task.organizationId,
  );
  const orphaned = orphanedCommentAttachments({
    taskId: task.id,
    removed,
    kept: [...keptComments, item?.description ?? ""],
  });
  await deleteAttachmentFiles(ctx.orgFs, orphaned, getUserId(ctx)!);
}

export const TASK_BOARD_COMMENT_LIST = defineTool({
  name: "TASK_BOARD_COMMENT_LIST",
  description:
    "List a task board item's comments (flat, oldest first; replies carry parentId). " +
    "Inside a task run, links to files attached to a comment are paths in your sandbox — `Read` them.",
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
    // Only a sandboxed run reaches this through the task-run endpoint, and only it has the uploads mount.
    if (!taskRunContextStore.getStore()) return { comments };
    return {
      comments: comments.map((comment) => ({
        ...comment,
        body: uploadsAsSandboxPaths(comment.body),
      })),
    };
  },
});

/**
 * A task-run agent (the QA reviewer) writes screenshots to `org/output/…` and
 * references them in its comment as markdown images `![alt](org/output/x.png)`.
 * `org/output` materializes into the org-fs `outputs` volume under the run's
 * thread id, served at `/api/<org>/fs/outputs/read?path=<threadId>/<subpath>` —
 * the same URL the thread Outputs panel builds. Rewrite those refs to that URL
 * here (the agent can't know its own thread id) so the image renders inline in
 * the comment. Only `org/output/…` image refs are touched; every other URL is
 * left as-is. `outputs` is a member-readable volume, so the browser's session
 * loads the same-origin `<img>`.
 */
const ORG_OUTPUT_IMG_RE = /(!\[[^\]]*\]\()org\/output\/([^)\s]+)(\))/g;
export function embedOrgOutputImages(
  body: string,
  threadId: string,
  orgSlug: string,
): string {
  return body.replace(ORG_OUTPUT_IMG_RE, (_m, pre, subpath, post) => {
    const path = encodeURIComponent(`${threadId}/${subpath}`);
    return `${pre}/api/${encodeURIComponent(orgSlug)}/fs/outputs/read?path=${path}${post}`;
  });
}

export const TASK_BOARD_COMMENT_CREATE = defineTool({
  name: "TASK_BOARD_COMMENT_CREATE",
  description: "Post a comment on a task board item, or a reply to one.",
  annotations: {
    title: "Create Task Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    body: z.string().trim().min(1).max(MAX_COMMENT_BODY_LENGTH),
    /** Reply target. Replying to a reply lands on its thread root. */
    parentId: z.string().nullish(),
  }),
  outputSchema: z.object({ comment: TaskBoardCommentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);
    // A comment from a task run is the Super Agent's, not the user's whose
    // credential the run acts under (the assigner) — see authorId below. The
    // store also carries the run's thread id, which is what turns the agent's
    // `org/output/…` screenshot refs into renderable image URLs.
    const taskRun = taskRunContextStore.getStore();
    const orgSlug = ctx.organization?.slug;
    const body =
      taskRun?.threadId && orgSlug
        ? embedOrgOutputImages(input.body, taskRun.threadId, orgSlug)
        : input.body;
    const comment = await ctx.storage.taskBoard.createComment({
      taskBoardItemId: input.taskBoardItemId,
      organizationId,
      parentId: input.parentId ?? null,
      // Same id the board already uses for the agent as an assignee, so the UI
      // renders it as the agent without a second concept.
      authorId: taskRun ? SUPER_AGENT_ASSIGNEE_ID : getUserId(ctx)!,
      // Which run wrote it — the only way to tell one agent's comments from
      // another's, since they all share the author id above.
      threadId: taskRun?.threadId ?? null,
      body,
    });
    if (!comment) throw new Error("Task board item not found");
    // Not an activity action, hence its own fan-out. The agent has no inbox.
    await ctx.storage.notifications.notify({
      taskBoardItemId: comment.taskBoardItemId,
      type: "commented",
      actorId: taskRun ? null : getUserId(ctx)!,
      alsoSubscribe: taskRun ? [] : [getUserId(ctx)!],
    });
    // Separate from the "commented" fan-out above: that one reaches the task's
    // followers, this one the people the comment names — who may be neither.
    await ctx.storage.notifications.notifyMentions({
      taskBoardItemId: comment.taskBoardItemId,
      organizationId,
      actorId: taskRun ? null : getUserId(ctx)!,
      body: comment.body,
    });
    return { comment };
  },
});

export const TASK_BOARD_COMMENT_UPDATE = defineTool({
  name: "TASK_BOARD_COMMENT_UPDATE",
  description:
    "Edit your own comment's body, or resolve/unresolve a comment thread " +
    "(root only, any org member may toggle it).",
  annotations: {
    title: "Update Task Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    body: z.string().trim().min(1).max(MAX_COMMENT_BODY_LENGTH).optional(),
    resolved: z.boolean().optional(),
  }),
  outputSchema: z.object({ comment: TaskBoardCommentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);
    const existing =
      input.body !== undefined
        ? await ctx.storage.taskBoard.getComment(input.id, organizationId)
        : null;
    const comment = await ctx.storage.taskBoard.updateComment({
      id: input.id,
      organizationId,
      callerId: getUserId(ctx)!,
      body: input.body,
      resolved: input.resolved,
    });
    if (!comment) {
      throw new Error(
        "Comment not found, or you can only edit your own comments",
      );
    }
    if (
      existing &&
      comment.body !== existing.body &&
      taskCommentAttachmentPaths(existing.body, comment.taskBoardItemId).length
    ) {
      const taskComments = await ctx.storage.taskBoard.listComments(
        comment.taskBoardItemId,
        organizationId,
      );
      await deleteOrphanedAttachments(
        ctx,
        { id: comment.taskBoardItemId, organizationId },
        [existing.body],
        taskComments.map((c) => c.body),
      );
    }
    // Notify only mentions this edit added, same as an edited description.
    if (input.body !== undefined && comment.body !== existing?.body) {
      await ctx.storage.notifications.notifyMentions({
        taskBoardItemId: comment.taskBoardItemId,
        organizationId,
        actorId: getUserId(ctx)!,
        body: comment.body,
        previousBody: existing?.body ?? null,
      });
    }
    return { comment };
  },
});

export const TASK_BOARD_COMMENT_DELETE = defineTool({
  name: "TASK_BOARD_COMMENT_DELETE",
  description:
    "Delete your own comment. Deleting a thread root deletes its replies too.",
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
    const comment = await ctx.storage.taskBoard.getComment(
      input.id,
      organizationId,
    );
    if (!comment) return { success: false };
    // Read before the delete, which takes a root's replies with it.
    const taskComments = await ctx.storage.taskBoard.listComments(
      comment.taskBoardItemId,
      organizationId,
    );
    const deleted = await ctx.storage.taskBoard.deleteComment(
      input.id,
      organizationId,
      getUserId(ctx)!,
    );
    if (!deleted) return { success: false };

    const isRemoved = (c: { id: string; parentId: string | null }) =>
      c.id === comment.id || c.parentId === comment.id;
    await deleteOrphanedAttachments(
      ctx,
      { id: comment.taskBoardItemId, organizationId },
      taskComments.filter(isRemoved).map((c) => c.body),
      taskComments.filter((c) => !isRemoved(c)).map((c) => c.body),
    );
    return { success: true };
  },
});
