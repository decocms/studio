import { sql, type Kysely } from "kysely";
import type { Database } from "./types";

export interface ForumCursor {
  rank: number;
  time: string;
  id: string;
}
export interface ForumInput {
  itemIds?: string[];
  filter: "all" | "mentions" | "unread" | "unread_mentions";
  sort: "personal" | "latest";
  limit: number;
  cursor?: ForumCursor;
}
interface ForumRow {
  id: string;
  replyCount: number;
  unreadCount: number;
  mentionCount: number;
  participantIds: string[];
  lastReply: {
    id: string;
    authorId: string;
    body: string;
    createdAt: string;
  } | null;
  lastParticipatedAt: string | null;
  lastActivityAt: string;
  rank: number;
  time: string;
}

/** Aggregates only database data; never fans out to comments/PR APIs per row. */
export async function listForum(
  db: Kysely<Database>,
  orgId: string,
  userId: string,
  input: ForumInput,
) {
  const rows = await sql<ForumRow>`
    WITH summaries AS (
      SELECT i.id,
        c.reply_count::int AS "replyCount", c.unread_count::int AS "unreadCount",
        n.mention_count::int AS "mentionCount",
        coalesce(c.participants, ARRAY[]::text[]) AS "participantIds",
        (SELECT jsonb_build_object('id', r.id, 'authorId', r.author_id,
          'body', left(r.body, 300), 'createdAt', r.created_at)
          FROM task_board_comments r WHERE r.task_board_item_id = i.id
          ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS "lastReply",
        greatest(c.my_last, a.my_last) AS participated,
        greatest(i.created_at, c.last_at, a.last_at) AS active
      FROM task_board_items i
      LEFT JOIN task_board_read_markers m ON m.task_board_item_id = i.id AND m.user_id = ${userId}
      CROSS JOIN LATERAL (
        SELECT count(*) AS reply_count,
          count(*) FILTER (WHERE author_id <> ${userId} AND
            (m.comment_id IS NULL OR (created_at, id) > (m.comment_created_at, m.comment_id))) AS unread_count,
          array_agg(DISTINCT author_id) AS participants,
          max(created_at) AS last_at,
          max(created_at) FILTER (WHERE author_id = ${userId}) AS my_last
        FROM task_board_comments WHERE task_board_item_id = i.id
      ) c
      CROSS JOIN LATERAL (
        SELECT max(occurred_at) AS last_at,
          max(occurred_at) FILTER (WHERE actor_id = ${userId}) AS my_last
        FROM task_board_activity WHERE task_board_item_id = i.id
      ) a
      CROSS JOIN LATERAL (
        SELECT count(*) AS mention_count FROM notifications
        WHERE task_board_item_id = i.id AND organization_id = ${orgId}
          AND user_id = ${userId} AND read_at IS NULL AND type = 'mentioned'
      ) n
      WHERE i.organization_id = ${orgId} AND i.dismissed_at IS NULL AND i.source IS NULL
        ${input.itemIds ? sql`AND i.id = ANY(${input.itemIds}::text[])` : sql``}
    ), ranked AS (
      SELECT *, CASE WHEN ${input.sort} = 'latest' THEN 0
        WHEN "unreadCount" > 0 THEN 0 WHEN "mentionCount" > 0 THEN 1 ELSE 2 END AS rank,
        active AS sort_time
      FROM summaries
      WHERE (${input.filter} = 'all' OR (${input.filter} = 'mentions' AND "mentionCount" > 0)
        OR (${input.filter} = 'unread' AND "unreadCount" > 0)
        OR (${input.filter} = 'unread_mentions' AND "mentionCount" > 0 AND "unreadCount" > 0))
    )
    SELECT id, "replyCount", "unreadCount", "mentionCount", "participantIds", "lastReply",
      participated::text AS "lastParticipatedAt", active::text AS "lastActivityAt",
      rank, sort_time::text AS time
    FROM ranked
    ${
      input.cursor
        ? sql`WHERE rank > ${input.cursor.rank} OR (rank = ${input.cursor.rank}
      AND (sort_time, id) < (${input.cursor.time}::timestamptz, ${input.cursor.id}))`
        : sql``
    }
    ORDER BY rank ASC, sort_time DESC, id DESC LIMIT ${input.limit + 1}
  `.execute(db);
  const page = rows.rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      ...row,
      lastActivityAt: new Date(row.lastActivityAt).toISOString(),
      lastParticipatedAt: row.lastParticipatedAt
        ? new Date(row.lastParticipatedAt).toISOString()
        : null,
    })),
    nextCursor:
      rows.rows.length > input.limit && last
        ? { rank: last.rank, time: last.time, id: last.id }
        : null,
  };
}

export async function conversationReadState(
  db: Kysely<Database>,
  orgId: string,
  userId: string,
  itemId: string,
) {
  const { rows } = await sql<{
    unreadCommentIds: string[];
    notificationIds: string[];
  }>`
    SELECT ARRAY(SELECT c.id FROM task_board_comments c
      LEFT JOIN task_board_read_markers m ON m.task_board_item_id = c.task_board_item_id AND m.user_id = ${userId}
      WHERE c.task_board_item_id = i.id AND c.author_id <> ${userId}
        AND (m.comment_id IS NULL OR (c.created_at, c.id) > (m.comment_created_at, m.comment_id))
      ORDER BY c.created_at, c.id) AS "unreadCommentIds",
      ARRAY(SELECT n.id FROM notifications n WHERE n.task_board_item_id = i.id
        AND n.organization_id = ${orgId} AND n.user_id = ${userId} AND n.read_at IS NULL
        ORDER BY n.created_at, n.id LIMIT 1000) AS "notificationIds"
    FROM task_board_items i WHERE i.id = ${itemId} AND i.organization_id = ${orgId}
  `.execute(db);
  return rows[0] ?? null;
}

/** The boundary is an observed comment, never the client's clock. Stale tabs
 * cannot move it backwards; deleting a comment does not reset the marker. */
export async function markConversationRead(
  db: Kysely<Database>,
  orgId: string,
  userId: string,
  itemId: string,
  throughCommentId: string | null,
  notificationIds: string[],
) {
  return db.transaction().execute(async (tx) => {
    const task = await tx
      .selectFrom("task_board_items")
      .select("id")
      .where("organization_id", "=", orgId)
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!task) return false;
    if (throughCommentId) {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO task_board_read_markers (user_id, task_board_item_id, comment_created_at, comment_id)
        SELECT ${userId}, task_board_item_id, created_at, id FROM task_board_comments
        WHERE id = ${throughCommentId} AND task_board_item_id = ${itemId}
        ON CONFLICT (user_id, task_board_item_id) DO UPDATE SET
          comment_created_at = excluded.comment_created_at, comment_id = excluded.comment_id
        WHERE (task_board_read_markers.comment_created_at, task_board_read_markers.comment_id)
          < (excluded.comment_created_at, excluded.comment_id)
        RETURNING comment_id AS id
      `.execute(tx);
      // A stale marker is a successful no-op, but an unrelated comment must
      // never acknowledge this task's notifications.
      if (!rows.length) {
        const comment = await tx
          .selectFrom("task_board_comments")
          .select("id")
          .where("id", "=", throughCommentId)
          .where("task_board_item_id", "=", itemId)
          .executeTakeFirst();
        if (!comment) return false;
      }
    }
    if (notificationIds.length)
      await tx
        .updateTable("notifications")
        .set({ read_at: new Date() })
        .where("organization_id", "=", orgId)
        .where("user_id", "=", userId)
        .where("task_board_item_id", "=", itemId)
        .where("id", "in", notificationIds)
        .where("read_at", "is", null)
        .execute();
    return true;
  });
}
