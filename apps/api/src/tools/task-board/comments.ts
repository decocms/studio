/**
 * Task comments — a lightweight discussion stream on a task board item, with
 * one level of replies (`parentId`) and optional image/file attachments
 * carried inline as base64 (decoded and stored with the comment).
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import {
  MAX_ATTACHMENT_BYTES,
  TaskBoardAttachmentUploadSchema,
  TaskBoardCommentSchema,
} from "./schema";

function requireOrgId(ctx: StudioContext): string {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

async function requireTask(
  ctx: StudioContext,
  taskBoardItemId: string,
  organizationId: string,
): Promise<void> {
  const task = await ctx.storage.taskBoard.getById(
    taskBoardItemId,
    organizationId,
  );
  if (!task) throw new Error(`Task board item not found: ${taskBoardItemId}`);
}

/** Decode a base64 upload, enforcing the size cap post-decode. */
export function decodeAttachmentUpload(upload: {
  filename: string;
  dataBase64: string;
}): Uint8Array {
  const data = Uint8Array.from(Buffer.from(upload.dataBase64, "base64"));
  if (data.byteLength === 0) {
    throw new Error(`Attachment "${upload.filename}" is empty`);
  }
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment "${upload.filename}" exceeds the ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit`,
    );
  }
  return data;
}

export const TASK_BOARD_COMMENT_CREATE = defineTool({
  name: "TASK_BOARD_COMMENT_CREATE",
  description:
    "Add a comment to a task board item, optionally as a reply to another comment and with image/file attachments.",
  annotations: {
    title: "Create Task Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    /** Reply target — must be a top-level comment on the same task. */
    parentId: z.string().nullable().optional(),
    body: z.string().min(1).max(10_000),
    attachments: z.array(TaskBoardAttachmentUploadSchema).max(5).optional(),
  }),
  outputSchema: z.object({ comment: TaskBoardCommentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrgId(ctx);
    await requireTask(ctx, input.taskBoardItemId, organizationId);

    if (input.parentId) {
      const parent = await ctx.storage.taskBoard.getCommentById(
        input.parentId,
        organizationId,
      );
      if (!parent || parent.taskBoardItemId !== input.taskBoardItemId) {
        throw new Error("Reply target not found on this task");
      }
      if (parent.parentId) {
        throw new Error(
          "Replies are one level deep — reply to the thread's top comment",
        );
      }
    }

    // Decode (and size-check) every upload BEFORE any write, so a bad file
    // can't leave a comment with half its attachments.
    const uploads = (input.attachments ?? []).map((a) => ({
      ...a,
      data: decodeAttachmentUpload(a),
    }));

    const comment = await ctx.storage.taskBoard.createComment({
      organizationId,
      taskBoardItemId: input.taskBoardItemId,
      parentId: input.parentId ?? null,
      body: input.body,
      by: getUserId(ctx)!,
    });
    for (const upload of uploads) {
      comment.attachments.push(
        await ctx.storage.taskBoard.addAttachment({
          organizationId,
          taskBoardItemId: input.taskBoardItemId,
          commentId: comment.id,
          filename: upload.filename,
          mimeType: upload.mimeType,
          data: upload.data,
          by: getUserId(ctx)!,
        }),
      );
    }

    return { comment };
  },
});

export const TASK_BOARD_COMMENT_LIST = defineTool({
  name: "TASK_BOARD_COMMENT_LIST",
  description:
    "List the comments on a task board item (oldest first, replies included flat via parentId).",
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
    const organizationId = requireOrgId(ctx);
    const comments = await ctx.storage.taskBoard.listComments(
      input.taskBoardItemId,
      organizationId,
    );
    return { comments };
  },
});

export const TASK_BOARD_COMMENT_UPDATE = defineTool({
  name: "TASK_BOARD_COMMENT_UPDATE",
  description: "Edit the body of a task comment you authored.",
  annotations: {
    title: "Update Task Comment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    body: z.string().min(1).max(10_000),
  }),
  outputSchema: z.object({ comment: TaskBoardCommentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrgId(ctx);
    const existing = await ctx.storage.taskBoard.getCommentById(
      input.id,
      organizationId,
    );
    if (!existing) throw new Error(`Comment not found: ${input.id}`);
    if (existing.createdBy !== getUserId(ctx)) {
      throw new Error("Only the comment's author can edit it");
    }
    const comment = await ctx.storage.taskBoard.updateComment(
      input.id,
      organizationId,
      input.body,
    );
    return { comment };
  },
});

export const TASK_BOARD_COMMENT_DELETE = defineTool({
  name: "TASK_BOARD_COMMENT_DELETE",
  description:
    "Delete a task comment you authored (its replies and attachments go with it).",
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
    const organizationId = requireOrgId(ctx);
    const existing = await ctx.storage.taskBoard.getCommentById(
      input.id,
      organizationId,
    );
    if (!existing) return { success: true };
    if (existing.createdBy !== getUserId(ctx)) {
      throw new Error("Only the comment's author can delete it");
    }
    await ctx.storage.taskBoard.deleteComment(input.id, organizationId);
    return { success: true };
  },
});
