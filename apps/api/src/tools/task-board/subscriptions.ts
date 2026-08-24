/**
 * Subscribing to a task, and the inbox that subscriptions feed.
 *
 * Subscribing is one toggle covering both channels: the in-product inbox and
 * the batched email digest. Read state is a single per-(user, org) cursor
 * rather than per-item flags — the inbox is a popover you clear, not a mailbox
 * you triage.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import { TaskBoardActivityActionSchema } from "./schema";

function requireOrg(ctx: StudioContext): string {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

/** The caller's own user id. A subscription belongs to a person, so a
 *  principal without one (an agent run, a machine API key) has nothing here. */
function requireUserId(ctx: StudioContext): string {
  const userId = getUserId(ctx);
  if (!userId) {
    throw new Error("A user session is required to follow a task");
  }
  return userId;
}

/**
 * Resolve a task within the caller's org, or throw. `task_board_subscribers`
 * is keyed by task id alone, so this is where a subscription write gets its
 * tenant scope.
 */
async function requireItem(
  ctx: StudioContext,
  taskBoardItemId: string,
  organizationId: string,
): Promise<void> {
  const item = await ctx.storage.taskBoard.getById(
    taskBoardItemId,
    organizationId,
  );
  if (!item) throw new Error("Task board item not found");
}

/**
 * Subscribe the people a change implies — the creator, a new assignee, someone
 * who just commented — without overriding anyone's explicit choice.
 *
 * Best-effort, like the activity log it sits beside: failing to add a follower
 * must never fail the change that would have notified them. Non-user ids (the
 * Super Agent, the reports importer) are dropped inside `autoSubscribe`.
 */
export async function autoSubscribeToTask(
  ctx: StudioContext,
  taskBoardItemId: string,
  userIds: (string | null | undefined)[],
): Promise<void> {
  try {
    await ctx.storage.notifications.autoSubscribe(taskBoardItemId, userIds);
  } catch (err) {
    console.error("[task-board] auto-subscribe failed", err);
  }
}

const SubscriptionStateSchema = z.object({
  /** Everyone following the task, for the avatar stack. */
  subscriberIds: z.array(z.string()),
  /** Whether the caller is one of them. */
  subscribed: z.boolean(),
});

/** One unseen update: the activity row plus the task it happened on, so the
 *  inbox can render a row without a second fetch per item. */
const InboxItemSchema = z.object({
  id: z.string(),
  taskBoardItemId: z.string(),
  taskTitle: z.string(),
  taskKeySeq: z.number(),
  action: TaskBoardActivityActionSchema,
  actorId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  occurredAt: z.string().datetime(),
});

export const TASK_BOARD_SUBSCRIPTION_GET = defineTool({
  name: "TASK_BOARD_SUBSCRIPTION_GET",
  description:
    "Get a task board item's subscribers, and whether the caller is subscribed.",
  annotations: {
    title: "Get Task Subscription",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: SubscriptionStateSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);
    const userId = requireUserId(ctx);
    await requireItem(ctx, input.taskBoardItemId, organizationId);
    const subscriberIds = await ctx.storage.notifications.listSubscribers(
      input.taskBoardItemId,
    );
    return { subscriberIds, subscribed: subscriberIds.includes(userId) };
  },
});

export const TASK_BOARD_SUBSCRIPTION_SET = defineTool({
  name: "TASK_BOARD_SUBSCRIPTION_SET",
  description:
    "Subscribe to or unsubscribe from a task board item's updates (inbox + email digest).",
  annotations: {
    title: "Set Task Subscription",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    subscribed: z.boolean(),
  }),
  outputSchema: SubscriptionStateSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);
    const userId = requireUserId(ctx);
    await requireItem(ctx, input.taskBoardItemId, organizationId);

    await ctx.storage.notifications.setSubscribed(
      input.taskBoardItemId,
      userId,
      input.subscribed,
    );
    const subscriberIds = await ctx.storage.notifications.listSubscribers(
      input.taskBoardItemId,
    );
    return { subscriberIds, subscribed: subscriberIds.includes(userId) };
  },
});

export const TASK_BOARD_INBOX_LIST = defineTool({
  name: "TASK_BOARD_INBOX_LIST",
  description:
    "List unread updates on the tasks the caller subscribes to, newest first.",
  annotations: {
    title: "List Inbox",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(50),
  }),
  outputSchema: z.object({
    items: z.array(InboxItemSchema),
    lastReadAt: z.string().datetime().nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);
    const userId = requireUserId(ctx);
    const [items, { lastReadAt }] = await Promise.all([
      ctx.storage.notifications.listInbox(userId, organizationId, input.limit),
      ctx.storage.notifications.readState(userId, organizationId),
    ]);
    return { items, lastReadAt };
  },
});

export const TASK_BOARD_INBOX_MARK_READ = defineTool({
  name: "TASK_BOARD_INBOX_MARK_READ",
  description: "Clear the caller's task inbox up to a point in time.",
  annotations: {
    title: "Mark Inbox Read",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    /** Defaults to now. A caller passing the newest item it actually rendered
     *  won't swallow updates that landed while the popover was open. */
    through: z.string().datetime().optional(),
  }),
  outputSchema: z.object({ lastReadAt: z.string().datetime() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);
    const userId = requireUserId(ctx);
    const through = input.through ? new Date(input.through) : new Date();
    await ctx.storage.notifications.markRead(userId, organizationId, through);
    const { lastReadAt } = await ctx.storage.notifications.readState(
      userId,
      organizationId,
    );
    return { lastReadAt: lastReadAt ?? through.toISOString() };
  },
});
