/**
 * Forum tools. A channel is a project with `metadata.forum`, a topic is a task
 * card in that project, a reply is a card comment. Topics are created with
 * `TASK_BOARD_ITEM_CREATE` (`projectId`) and replied to with
 * `TASK_BOARD_COMMENT_CREATE`. See `apps/web/docs/public-org-forum-plan.md`.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  type StudioContext,
} from "@/core/studio-context";
import { VirtualMcpForumSchema } from "@decocms/shared/sdk/types";

const AuthorSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
});

const ChannelSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  forum: VirtualMcpForumSchema,
  topicCount: z.number(),
  lastActivityAt: z.string().nullable(),
});

const TopicSchema = z.object({
  id: z.string(),
  keySeq: z.number(),
  channelId: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  status: z.string(),
  author: AuthorSchema,
  assigneeId: z.string().nullable(),
  tags: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string().nullable(),
    }),
  ),
  votes: z.number(),
  viewerVoted: z.boolean(),
  replyCount: z.number(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
});

const ReplySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  author: AuthorSchema,
  body: z.string(),
  createdAt: z.string(),
});

function scope(ctx: StudioContext): { organizationId: string; userId: string } {
  requireAuth(ctx);
  const organizationId = ctx.organization?.id;
  const userId = getUserId(ctx);
  if (!organizationId || !userId) {
    throw new Error("Organization ID required (no active organization)");
  }
  return { organizationId, userId };
}

export const FORUM_CHANNEL_LIST = defineTool({
  name: "FORUM_CHANNEL_LIST",
  description:
    "List the organization's forum channels (projects marked as forums) with topic counts.",
  annotations: {
    title: "List Forum Channels",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ channels: z.array(ChannelSchema) }),
  handler: async (_input, ctx) => {
    const { organizationId } = scope(ctx);
    await ctx.access.check();
    return { channels: await ctx.storage.forum.listChannels(organizationId) };
  },
});

export const FORUM_TOPIC_LIST = defineTool({
  name: "FORUM_TOPIC_LIST",
  description:
    "List forum topics (cards filed in a project), newest first, with votes and reply counts. Omit channelId for every forum channel.",
  annotations: {
    title: "List Forum Topics",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ channelId: z.string().optional() }),
  outputSchema: z.object({ topics: z.array(TopicSchema) }),
  handler: async (input, ctx) => {
    const { organizationId, userId } = scope(ctx);
    await ctx.access.check();
    // One project's cards (any project of the org), or every forum channel's.
    let ids: string[];
    if (input.channelId) {
      const project = await ctx.storage.virtualMcps.findById(
        input.channelId,
        organizationId,
      );
      if (project?.organization_id !== organizationId) {
        throw new Error("Project not found");
      }
      ids = [project.id];
    } else {
      const channels = await ctx.storage.forum.listChannels(organizationId);
      ids = channels.map((c) => c.id);
    }
    return {
      topics: await ctx.storage.forum.listTopics(organizationId, userId, ids),
    };
  },
});

export const FORUM_TOPIC_GET = defineTool({
  name: "FORUM_TOPIC_GET",
  description: "Get one forum topic by its key number, with its replies.",
  annotations: {
    title: "Get Forum Topic",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ keySeq: z.number().int().positive() }),
  outputSchema: z.object({
    topic: TopicSchema,
    replies: z.array(ReplySchema),
  }),
  handler: async (input, ctx) => {
    const { organizationId, userId } = scope(ctx);
    await ctx.access.check();
    const topic = await ctx.storage.forum.getTopic(
      organizationId,
      userId,
      input.keySeq,
    );
    if (!topic) throw new Error("Topic not found");
    return { topic, replies: await ctx.storage.forum.listReplies(topic.id) };
  },
});

export const FORUM_TOPIC_VOTE = defineTool({
  name: "FORUM_TOPIC_VOTE",
  description: "Toggle the caller's upvote on a forum topic.",
  annotations: {
    title: "Vote on Forum Topic",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({ topicId: z.string() }),
  outputSchema: z.object({ voted: z.boolean(), votes: z.number() }),
  handler: async (input, ctx) => {
    const { organizationId, userId } = scope(ctx);
    await ctx.access.check();
    const item = await ctx.storage.taskBoard.getById(
      input.topicId,
      organizationId,
    );
    if (!item) throw new Error("Topic not found");
    return ctx.storage.forum.toggleVote(item.id, userId);
  },
});
