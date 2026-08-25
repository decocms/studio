/**
 * The inbox read: the current user's unread task updates in the current org.
 *
 * Unread-only, because the inbox shows unseen changes and "Mark all read"
 * empties it. No cursor — `unreadCount` already tells the UI there is more.
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
  inputSchema: z.object({}),
  outputSchema: z.object({
    notifications: z.array(NotificationSchema),
    unreadCount: z.number(),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const { notifications, unreadCount } =
      await ctx.storage.notifications.listUnread(
        getUserId(ctx)!,
        requireOrg(ctx),
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
    };
  },
});
