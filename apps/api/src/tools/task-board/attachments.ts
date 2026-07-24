/**
 * Task attachments — files/images on a task board item. Uploads arrive as
 * base64 through the tool (size-capped); bytes are served by the org-scoped
 * `GET /api/:org/task-board/attachments/:id` route, never inlined in tool
 * outputs.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import {
  TaskBoardAttachmentMetaSchema,
  TaskBoardAttachmentUploadSchema,
} from "./schema";
import { decodeAttachmentUpload } from "./comments";

export const TASK_BOARD_ATTACHMENT_ADD = defineTool({
  name: "TASK_BOARD_ATTACHMENT_ADD",
  description:
    "Attach a file or image to a task board item. Content is base64-encoded, capped at 10MB.",
  annotations: {
    title: "Add Task Attachment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: TaskBoardAttachmentUploadSchema.extend({
    taskBoardItemId: z.string(),
  }),
  outputSchema: z.object({ attachment: TaskBoardAttachmentMetaSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const task = await ctx.storage.taskBoard.getById(
      input.taskBoardItemId,
      organizationId,
    );
    if (!task) {
      throw new Error(`Task board item not found: ${input.taskBoardItemId}`);
    }

    const attachment = await ctx.storage.taskBoard.addAttachment({
      organizationId,
      taskBoardItemId: input.taskBoardItemId,
      filename: input.filename,
      mimeType: input.mimeType,
      data: decodeAttachmentUpload(input),
      by: getUserId(ctx)!,
    });
    return { attachment };
  },
});

export const TASK_BOARD_ATTACHMENT_LIST = defineTool({
  name: "TASK_BOARD_ATTACHMENT_LIST",
  description:
    "List attachment metadata for a task board item (task-level and comment-level).",
  annotations: {
    title: "List Task Attachments",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: z.object({
    attachments: z.array(TaskBoardAttachmentMetaSchema),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const attachments = await ctx.storage.taskBoard.listAttachments(
      input.taskBoardItemId,
      organizationId,
    );
    return { attachments };
  },
});

export const TASK_BOARD_ATTACHMENT_DELETE = defineTool({
  name: "TASK_BOARD_ATTACHMENT_DELETE",
  description: "Delete an attachment from a task board item.",
  annotations: {
    title: "Delete Task Attachment",
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
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    await ctx.storage.taskBoard.deleteAttachment(input.id, organizationId);
    return { success: true };
  },
});
