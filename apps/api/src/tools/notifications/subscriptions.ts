/**
 * The Follow toggle. Both tools resolve the task through the caller's org
 * before reading or writing anything — the column scopes the reads, this gate
 * stops a subscription being created across tenants in the first place.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import { requireTaskInOrg } from "./org";

export const NOTIFICATION_SUBSCRIPTION_SET = defineTool({
  name: "NOTIFICATION_SUBSCRIPTION_SET",
  description: "Follow or unfollow a task board item.",
  annotations: {
    title: "Set Notification Subscription",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    subscribed: z.boolean(),
  }),
  outputSchema: z.object({ subscribed: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    await requireTaskInOrg(ctx, input.taskBoardItemId);
    await ctx.storage.notifications.setSubscribed(
      getUserId(ctx)!,
      input.taskBoardItemId,
      input.subscribed,
    );
    return { subscribed: input.subscribed };
  },
});

export const NOTIFICATION_SUBSCRIPTION_LIST = defineTool({
  name: "NOTIFICATION_SUBSCRIPTION_LIST",
  description: "List the user ids following a task board item.",
  annotations: {
    title: "List Notification Subscribers",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: z.object({ userIds: z.array(z.string()) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    await requireTaskInOrg(ctx, input.taskBoardItemId);
    const userIds = await ctx.storage.notifications.listSubscribers(
      input.taskBoardItemId,
    );
    return { userIds };
  },
});
