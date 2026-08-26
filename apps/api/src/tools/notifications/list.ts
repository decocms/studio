/**
 * The inbox read: the current user's unread task updates in the current org.
 *
 * Unread-only, because the inbox shows unseen changes and "Mark all read"
 * empties it. Keyset-paged so the popover can scroll a long backlog;
 * `unreadCount` is always the full count, not the page's.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import { NOTIFICATION_TYPES } from "@decocms/shared/notification-types";
import { requireOrg } from "./org";

const NotificationSchema = z.object({
  id: z.string(),
  taskBoardItemId: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  taskTitle: z.string(),
  /** Per-org sequence behind the card's human key (`DECO-01`). */
  taskKeySeq: z.number().nullable(),
  /** Null for the agent/system — the row renders its glyph. */
  actorName: z.string().nullable(),
  actorImage: z.string().nullable(),
  createdAt: z.string(),
});

export const NOTIFICATION_LIST = defineTool({
  name: "NOTIFICATION_LIST",
  description:
    "List the current user's unread notifications in the current organization, newest first.",
  annotations: {
    title: "List Notifications",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    /** `nextCursor` from the previous page. Omit for the newest page. */
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(50).optional(),
  }),
  outputSchema: z.object({
    notifications: z.array(NotificationSchema),
    unreadCount: z.number(),
    /** Null when this is the last page. */
    nextCursor: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const { notifications, unreadCount, nextCursor } =
      await ctx.storage.notifications.listUnread(
        getUserId(ctx)!,
        requireOrg(ctx),
        { cursor: input.cursor, limit: input.limit },
      );
    return {
      notifications: notifications.map((n) => ({
        id: n.id,
        taskBoardItemId: n.taskBoardItemId,
        type: n.type,
        taskTitle: n.data.taskTitle,
        taskKeySeq: n.data.taskKeySeq,
        actorName: n.data.actorName,
        actorImage: n.data.actorImage,
        createdAt: n.createdAt,
      })),
      unreadCount,
      nextCursor,
    };
  },
});
