import { emitNotificationsRead } from "@/notifications/read-events";
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import { requireOrg } from "../notifications/org";
import { emitTaskConversationUpdated } from "./conversation-events";

const CursorSchema = z.object({
  rank: z.number().int().min(0).max(2),
  // SQL emits the exact microsecond timestamp. Validate before casting in SQL.
  time: z
    .string()
    .max(40)
    .regex(
      /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/,
    )
    .refine((value) => Number.isFinite(Date.parse(value))),
  id: z.string().max(200),
});

export const TASK_BOARD_FORUM_LIST = defineTool({
  name: "TASK_BOARD_FORUM_LIST",
  description:
    "List task conversation summaries, ordered by personal relevance or latest activity.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    // The board's existing project/date filters resolve its eligible task ids.
    itemIds: z.array(z.string().max(200)).max(10000).optional(),
    filter: z
      .enum(["all", "mentions", "unread", "unread_mentions"])
      .default("all"),
    sort: z.enum(["personal", "latest"]).default("personal"),
    limit: z.number().int().min(1).max(100).default(40),
    cursor: CursorSchema.optional(),
  }),
  outputSchema: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        replyCount: z.number(),
        unreadCount: z.number(),
        mentionCount: z.number(),
        participantIds: z.array(z.string()),
        lastReply: z
          .object({
            id: z.string(),
            authorId: z.string(),
            body: z.string(),
            createdAt: z.string(),
          })
          .nullable(),
        lastParticipatedAt: z.string().nullable(),
        lastActivityAt: z.string(),
        rank: z.number(),
        time: z.string(),
      }),
    ),
    nextCursor: CursorSchema.nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    return ctx.storage.taskBoard.listForum(
      requireOrg(ctx),
      getUserId(ctx)!,
      input,
    );
  },
});

export const TASK_BOARD_CONVERSATION_MARK_READ = defineTool({
  name: "TASK_BOARD_CONVERSATION_MARK_READ",
  description:
    "Mark a task conversation read through an observed comment and acknowledge observed notifications.",
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    throughCommentId: z.string().nullable(),
    notificationIds: z.array(z.string()).max(1000).default([]),
  }),
  outputSchema: z.object({ success: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = requireOrg(ctx);
    const userId = getUserId(ctx)!;
    const success = await ctx.storage.taskBoard.markConversationRead(
      orgId,
      userId,
      input.taskBoardItemId,
      input.throughCommentId,
      input.notificationIds,
    );
    if (!success) throw new Error("Task or comment not found");
    emitTaskConversationUpdated(orgId, input.taskBoardItemId, userId);
    if (input.notificationIds.length) emitNotificationsRead(orgId, userId);
    return { success };
  },
});
