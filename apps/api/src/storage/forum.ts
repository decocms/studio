/**
 * Forum reads over the task board: channels are projects carrying
 * `metadata.forum`, topics are cards carrying the channel's id in
 * `project_id`, replies are card comments. Writes other than votes go through
 * `TaskBoardStorage`, so a topic stays an ordinary card on the board.
 */

import { type Kysely, sql } from "kysely";
import {
  VirtualMcpForumSchema,
  type VirtualMcpForum,
} from "@decocms/shared/sdk/types";
import type { Database } from "./types";

/** ponytail: a channel lists its newest topics only; paginate when a channel
 *  outgrows this. */
const MAX_TOPICS = 500;

export interface ForumAuthor {
  id: string;
  name: string;
  image: string | null;
}

export interface ForumChannel {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  forum: VirtualMcpForum;
  topicCount: number;
  lastActivityAt: string | null;
}

export interface ForumTopicTag {
  id: string;
  name: string;
  color: string | null;
}

export interface ForumTopic {
  id: string;
  keySeq: number;
  channelId: string;
  title: string;
  body: string | null;
  status: string;
  author: ForumAuthor;
  assigneeId: string | null;
  tags: ForumTopicTag[];
  votes: number;
  viewerVoted: boolean;
  replyCount: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface ForumReply {
  id: string;
  parentId: string | null;
  author: ForumAuthor;
  body: string;
  createdAt: string;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);

function parseForum(metadata: unknown): VirtualMcpForum | null {
  let value: unknown = metadata;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const forum = (value as { forum?: unknown } | null)?.forum;
  if (!forum) return null;
  const parsed = VirtualMcpForumSchema.safeParse(forum);
  return parsed.success ? parsed.data : null;
}

export class ForumStorage {
  constructor(private db: Kysely<Database>) {}

  async listChannels(organizationId: string): Promise<ForumChannel[]> {
    const projects = await this.db
      .selectFrom("connections")
      .select(["id", "title", "description", "icon", "metadata"])
      .where("organization_id", "=", organizationId)
      .where("connection_type", "=", "VIRTUAL")
      .where("status", "=", "active")
      .orderBy("created_at", "asc")
      .execute();

    const channels = projects.flatMap((p) => {
      const forum = parseForum(p.metadata);
      return forum ? [{ ...p, forum }] : [];
    });
    if (channels.length === 0) return [];

    const stats = await this.db
      .selectFrom("task_board_items")
      .select([
        "project_id",
        sql<number>`count(*)::int`.as("topic_count"),
        sql<Date | string>`max(updated_at)`.as("last_activity_at"),
      ])
      .where("organization_id", "=", organizationId)
      .where(
        "project_id",
        "in",
        channels.map((c) => c.id),
      )
      .where("status", "!=", "archived")
      .groupBy("project_id")
      .execute();
    const byId = new Map(stats.map((s) => [s.project_id, s]));

    return channels.map((c) => {
      const stat = byId.get(c.id);
      return {
        id: c.id,
        title: c.title,
        description: c.description,
        icon: c.icon,
        forum: c.forum,
        topicCount: stat?.topic_count ?? 0,
        lastActivityAt: stat ? iso(stat.last_activity_at) : null,
      };
    });
  }

  private topicQuery(organizationId: string, viewerId: string) {
    return this.db
      .selectFrom("task_board_items as i")
      .leftJoin("user as u", "u.id", "i.created_by")
      .select([
        "i.id",
        "i.key_seq",
        "i.project_id",
        "i.title",
        "i.description",
        "i.status",
        "i.assignee_id",
        "i.created_by",
        "i.created_at",
        "u.name as author_name",
        "u.image as author_image",
        sql<number>`(select count(*)::int from task_board_item_votes v where v.task_board_item_id = i.id)`.as(
          "votes",
        ),
        sql<boolean>`exists(select 1 from task_board_item_votes v where v.task_board_item_id = i.id and v.user_id = ${viewerId})`.as(
          "viewer_voted",
        ),
        sql<number>`(select count(*)::int from task_board_comments c where c.task_board_item_id = i.id)`.as(
          "reply_count",
        ),
        sql<
          Date | string
        >`greatest(i.created_at, (select max(c.created_at) from task_board_comments c where c.task_board_item_id = i.id))`.as(
          "last_activity_at",
        ),
      ])
      .where("i.organization_id", "=", organizationId)
      .where("i.project_id", "is not", null)
      .where("i.status", "!=", "archived")
      .where("i.dismissed_at", "is", null);
  }

  private async attachTags(
    rows: Awaited<
      ReturnType<ReturnType<ForumStorage["topicQuery"]>["execute"]>
    >,
  ): Promise<ForumTopic[]> {
    const ids = rows.map((r) => r.id);
    const tagRows = ids.length
      ? await this.db
          .selectFrom("task_board_item_tags as it")
          .innerJoin("organization_tags as t", "t.id", "it.id")
          .select(["it.task_board_item_id", "t.id", "t.name", "t.color"])
          .where("it.task_board_item_id", "in", ids)
          .execute()
      : [];
    const tagsByItem = new Map<string, ForumTopicTag[]>();
    for (const t of tagRows) {
      const list = tagsByItem.get(t.task_board_item_id) ?? [];
      list.push({ id: t.id, name: t.name, color: t.color });
      tagsByItem.set(t.task_board_item_id, list);
    }

    return rows.map((r) => ({
      id: r.id,
      keySeq: r.key_seq,
      channelId: r.project_id ?? "",
      title: r.title,
      body: r.description,
      status: r.status,
      author: {
        id: r.created_by,
        name: r.author_name ?? "",
        image: r.author_image ?? null,
      },
      assigneeId: r.assignee_id,
      tags: tagsByItem.get(r.id) ?? [],
      votes: r.votes,
      viewerVoted: r.viewer_voted,
      replyCount: r.reply_count,
      createdAt: iso(r.created_at),
      lastActivityAt: iso(r.last_activity_at),
    }));
  }

  async listTopics(
    organizationId: string,
    viewerId: string,
    channelIds: string[],
  ): Promise<ForumTopic[]> {
    if (channelIds.length === 0) return [];
    const rows = await this.topicQuery(organizationId, viewerId)
      .where("i.project_id", "in", channelIds)
      .orderBy("i.created_at", "desc")
      .limit(MAX_TOPICS)
      .execute();
    return this.attachTags(rows);
  }

  async getTopic(
    organizationId: string,
    viewerId: string,
    keySeq: number,
  ): Promise<ForumTopic | null> {
    const rows = await this.topicQuery(organizationId, viewerId)
      .where("i.key_seq", "=", keySeq)
      .execute();
    const [topic] = await this.attachTags(rows);
    return topic ?? null;
  }

  async listReplies(topicId: string): Promise<ForumReply[]> {
    const rows = await this.db
      .selectFrom("task_board_comments as c")
      .leftJoin("user as u", "u.id", "c.author_id")
      .select([
        "c.id",
        "c.parent_id",
        "c.author_id",
        "c.body",
        "c.created_at",
        "u.name as author_name",
        "u.image as author_image",
      ])
      .where("c.task_board_item_id", "=", topicId)
      .orderBy("c.created_at", "asc")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      author: {
        id: r.author_id,
        name: r.author_name ?? "",
        image: r.author_image ?? null,
      },
      body: r.body,
      createdAt: iso(r.created_at),
    }));
  }

  /** Flip the viewer's vote. The caller has already checked the topic is in
   *  the viewer's org. */
  async toggleVote(
    topicId: string,
    userId: string,
  ): Promise<{ voted: boolean; votes: number }> {
    const removed = await this.db
      .deleteFrom("task_board_item_votes")
      .where("task_board_item_id", "=", topicId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    const voted = Number(removed.numDeletedRows) === 0;
    if (voted) {
      await this.db
        .insertInto("task_board_item_votes")
        .values({ task_board_item_id: topicId, user_id: userId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    const { votes } = await this.db
      .selectFrom("task_board_item_votes")
      .select(sql<number>`count(*)::int`.as("votes"))
      .where("task_board_item_id", "=", topicId)
      .executeTakeFirstOrThrow();
    return { voted, votes };
  }
}
