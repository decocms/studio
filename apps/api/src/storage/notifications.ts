/**
 * Reads for the inbox and the follow toggle. The single writer of
 * `notifications` rows is `notifications/notify.ts`.
 */

import { sql, type Kysely } from "kysely";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { NotificationType } from "@decocms/shared/notification-types";
import type { Database } from "./types";
import {
  NotificationDataSchema,
  type NotificationData,
} from "../notifications/schema";
import { notify, type NotifyParams } from "../notifications/notify";

/** One page of the inbox. The popover scrolls and pages through the rest. */
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface Notification {
  id: string;
  taskBoardItemId: string;
  type: NotificationType;
  data: NotificationData;
  createdAt: string;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);

/** `${createdAt}|${id}`; anything else pages from the top rather than throwing. */
function parseCursor(
  cursor: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf("|");
  if (sep <= 0) return null;
  const createdAt = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

export class NotificationStorage {
  constructor(private db: Kysely<Database>) {}

  /**
   * One page of the user's unread notifications in this org, newest first.
   *
   * Keyset, not offset: rows leave the set as they are read, so an offset would
   * skip rows between pages. `cursor` is the opaque `${createdAt}|${id}` of the
   * last row of the previous page — `id` breaks the tie when two rows share a
   * timestamp, which a burst on one task produces routinely.
   */
  async listUnread(
    userId: string,
    organizationId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{
    notifications: Notification[];
    unreadCount: number;
    nextCursor: string | null;
  }> {
    const limit = Math.min(opts.limit ?? PAGE_SIZE, MAX_PAGE_SIZE);
    const after = parseCursor(opts.cursor);

    let listQuery = this.db
      .selectFrom("notifications")
      .select(["id", "task_board_item_id", "type", "data", "created_at"])
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .where("read_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1);
    if (after) {
      listQuery = listQuery.where(
        sql<boolean>`(created_at, id) < (${after.createdAt}, ${after.id})`,
      );
    }
    const page = await listQuery.execute();
    const rows = page.slice(0, limit);

    const count = await this.db
      .selectFrom("notifications")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .where("read_at", "is", null)
      .executeTakeFirst();

    const last = rows[rows.length - 1];
    return {
      nextCursor:
        page.length > limit && last
          ? `${iso(last.created_at)}|${last.id}`
          : null,
      notifications: rows.map((row) => ({
        id: row.id,
        taskBoardItemId: row.task_board_item_id,
        type: row.type,
        data: NotificationDataSchema.parse(row.data),
        createdAt: iso(row.created_at),
      })),
      unreadCount: Number(count?.count ?? 0),
    };
  }

  /** Idempotent. Omitted `ids` means every unread row of this user in this org. */
  async markRead(
    userId: string,
    organizationId: string,
    ids?: string[],
  ): Promise<number> {
    if (ids && ids.length === 0) return 0;
    let query = this.db
      .updateTable("notifications")
      .set({ read_at: new Date() })
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .where("read_at", "is", null);
    if (ids) query = query.where("id", "in", ids);
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  async setSubscribed(
    userId: string,
    taskBoardItemId: string,
    subscribed: boolean,
  ): Promise<void> {
    await this.db
      .insertInto("notification_subscriptions")
      .values({
        id: generatePrefixedId("nsub"),
        user_id: userId,
        task_board_item_id: taskBoardItemId,
        subscribed,
      })
      .onConflict((oc) =>
        oc
          .columns(["user_id", "task_board_item_id"])
          .doUpdateSet({ subscribed, updated_at: new Date() }),
      )
      .execute();
  }

  /** Fan out one event to this task's followers. The only writer of
   *  `notifications` rows; never throws. */
  async notify(params: Omit<NotifyParams, "db">): Promise<void> {
    await notify({ ...params, db: this.db });
  }

  /** The user ids following this task. */
  async listSubscribers(taskBoardItemId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("notification_subscriptions")
      .select("user_id")
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("subscribed", "=", true)
      .execute();
    return rows.map((row) => row.user_id);
  }
}
