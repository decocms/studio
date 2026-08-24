/**
 * Task subscriptions, the inbox, and the digest queue.
 *
 * Notifications are DERIVED, never stored. `task_board_activity` already
 * records every change to a task, and it is written by every path including
 * the ones that bypass `StudioContext` (`run-reactions`, `review-sweeper`). So
 * "what's new for this user" is a join of `task_board_subscribers` against that
 * log, bounded below by two watermarks: the subscription's `created_at` and the
 * user's cursor. Adding a `notifications` table would mean a fan-out writer at
 * every one of those call sites plus per-row read/emailed state, for no
 * behavior this feature needs.
 *
 * The digest is claimed BEFORE it is sent (`claimDigest`), which makes email
 * at-most-once: a pod that dies between the claim and the send drops that one
 * digest. That is deliberate — the alternative, claiming after sending, sends N
 * copies from N pods on the same race, and the inbox is the durable record
 * either way.
 */

import { sql, type Kysely } from "kysely";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type {
  Database,
  TaskBoardActivityAction,
  TaskNotification,
} from "./types";

/** A (user, org) pair with unemailed activity old enough to send, plus the
 *  cursor value that claim must find unchanged. */
export interface DigestCandidate {
  userId: string;
  userName: string | null;
  userEmail: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  /** Newest event in this digest — what the cursor advances to. Never `now()`,
   *  so activity arriving mid-tick stays pending instead of being skipped. */
  through: Date;
  eventCount: number;
  /** Cursor as read; `claimDigest` only wins if it is still this. */
  lastEmailedAt: Date | null;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);

/** Rows returned by the pending-activity join, before mapping. */
interface PendingRow {
  id: string;
  task_board_item_id: string;
  title: string;
  key_seq: number;
  action: TaskBoardActivityAction;
  actor_id: string | null;
  data: Record<string, unknown> | string | null;
  occurred_at: Date | string;
}

function notificationFromRow(row: PendingRow): TaskNotification {
  const data =
    typeof row.data === "string" ? JSON.parse(row.data) : (row.data ?? {});
  return {
    id: row.id,
    taskBoardItemId: row.task_board_item_id,
    taskTitle: row.title,
    taskKeySeq: row.key_seq,
    action: row.action,
    actorId: row.actor_id,
    data,
    occurredAt: iso(row.occurred_at),
  };
}

export class NotificationStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** Explicit subscribe/unsubscribe. `subscribed: false` writes a row rather
   *  than deleting one — that row is what makes the opt-out stick. */
  async setSubscribed(
    taskBoardItemId: string,
    userId: string,
    subscribed: boolean,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto("task_board_subscribers")
      .values({
        task_board_item_id: taskBoardItemId,
        user_id: userId,
        subscribed,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(["task_board_item_id", "user_id"])
          .doUpdateSet({ subscribed, updated_at: now }),
      )
      .execute();
  }

  /**
   * Subscribe the creator / assignee / a commenter, without ever overriding an
   * explicit choice (`do nothing` on conflict, so an opt-out survives).
   *
   * Filtering lives here, not at the three call sites: ids that aren't real
   * users — the Super Agent sentinel, the reports importer — are dropped by the
   * `select from user` guard, so a machine actor can neither create an orphan
   * row nor raise an FK error.
   *
   * `created_at` is stamped from the app clock rather than left to the column
   * default, so it is comparable with `task_board_activity.occurred_at` (also
   * an app-side `Date`) instead of straddling two clocks at two precisions.
   */
  async autoSubscribe(
    taskBoardItemId: string,
    userIds: (string | null | undefined)[],
  ): Promise<void> {
    const candidates = [
      ...new Set(
        userIds.filter(
          (id): id is string => !!id && id !== SUPER_AGENT_ASSIGNEE_ID,
        ),
      ),
    ];
    if (candidates.length === 0) return;

    const now = new Date();
    await this.db
      .insertInto("task_board_subscribers")
      .columns(["task_board_item_id", "user_id", "created_at", "updated_at"])
      .expression((eb) =>
        eb
          .selectFrom("user")
          .select([
            sql.lit(taskBoardItemId).as("task_board_item_id"),
            "user.id",
            sql<Date>`${now}`.as("created_at"),
            sql<Date>`${now}`.as("updated_at"),
          ])
          .where("user.id", "in", candidates),
      )
      .onConflict((oc) =>
        oc.columns(["task_board_item_id", "user_id"]).doNothing(),
      )
      .execute();
  }

  /**
   * Display names for the ids appearing in one digest, in one query.
   *
   * Scoped to members of the org, so an id from elsewhere resolves to nothing
   * and reads as "someone" rather than leaking a name across tenants.
   */
  async resolveMemberNames(
    organizationId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("member as m")
      .innerJoin("user as u", "u.id", "m.userId")
      .select(["u.id", "u.name", "u.email"])
      .where("m.organizationId", "=", organizationId)
      .where("u.id", "in", userIds)
      .execute();
    return new Map(
      rows.flatMap((r) => {
        const name = r.name || r.email;
        return name ? [[r.id, name] as const] : [];
      }),
    );
  }

  /** Everyone currently following a task, opt-outs excluded. */
  async listSubscribers(taskBoardItemId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("task_board_subscribers")
      .select("user_id")
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("subscribed", "=", true)
      .execute();
    return rows.map((r) => r.user_id);
  }

  /**
   * Activity a subscriber hasn't seen yet, newest first.
   *
   * The four `where` clauses are the whole notification policy:
   *   - `subscribed` — opt-outs get nothing.
   *   - `occurred_at >= s.created_at` — no history from before you subscribed.
   *     At-or-after, because auto-subscribe and the activity row it accompanies
   *     share a timestamp; the actor filter below is what stops that tie from
   *     notifying you about your own change.
   *   - `actor_id is distinct from s.user_id` — never notify your own action.
   *     `is distinct from` (not `<>`) is what keeps NULL-actor rows, i.e. the
   *     agent's own work, flowing through.
   *   - `occurred_at > cursor` — everything before the watermark is settled.
   *
   * The `member` join is the access re-check: leaving the org stops the feed.
   */
  private pendingQuery(
    userId: string,
    organizationId: string,
    cursor: "last_read_at" | "last_emailed_at",
  ) {
    return this.db
      .selectFrom("task_board_subscribers as s")
      .innerJoin("task_board_items as i", "i.id", "s.task_board_item_id")
      .innerJoin(
        "task_board_activity as a",
        "a.task_board_item_id",
        "s.task_board_item_id",
      )
      .innerJoin("member as m", (join) =>
        join
          .onRef("m.userId", "=", "s.user_id")
          .onRef("m.organizationId", "=", "i.organization_id"),
      )
      .leftJoin("task_notification_cursors as c", (join) =>
        join
          .onRef("c.user_id", "=", "s.user_id")
          .onRef("c.organization_id", "=", "i.organization_id"),
      )
      .where("s.user_id", "=", userId)
      .where("i.organization_id", "=", organizationId)
      .where("s.subscribed", "=", true)
      .whereRef("a.occurred_at", ">=", "s.created_at")
      .where(sql<boolean>`a.actor_id is distinct from s.user_id`)
      .where(
        sql<boolean>`a.occurred_at > coalesce(c.${sql.ref(cursor)}, '-infinity'::timestamptz)`,
      );
  }

  /** The inbox: unseen activity across every task this user follows. */
  async listInbox(
    userId: string,
    organizationId: string,
    limit: number,
  ): Promise<TaskNotification[]> {
    const rows = await this.pendingQuery(userId, organizationId, "last_read_at")
      .select([
        "a.id",
        "a.task_board_item_id",
        "i.title",
        "i.key_seq",
        "a.action",
        "a.actor_id",
        "a.data",
        "a.occurred_at",
      ])
      .orderBy("a.occurred_at", "desc")
      .limit(limit)
      .execute();
    return (rows as PendingRow[]).map(notificationFromRow);
  }

  /** Where the user's inbox stands: the dot, and the watermark behind it. */
  async readState(
    userId: string,
    organizationId: string,
  ): Promise<{ lastReadAt: string | null }> {
    const row = await this.db
      .selectFrom("task_notification_cursors")
      .select("last_read_at")
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return {
      lastReadAt: row?.last_read_at ? iso(row.last_read_at) : null,
    };
  }

  /** Clear the dot up to `through`. Never moves the watermark backwards — a
   *  slow tab reporting a stale timestamp must not resurrect read items. */
  async markRead(
    userId: string,
    organizationId: string,
    through: Date,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto("task_notification_cursors")
      .values({
        user_id: userId,
        organization_id: organizationId,
        last_read_at: through,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "organization_id"]).doUpdateSet({
          last_read_at: sql`greatest(task_notification_cursors.last_read_at, excluded.last_read_at)`,
          updated_at: now,
        }),
      )
      .execute();
  }

  /**
   * Whose digest is due: every (user, org) whose oldest unemailed event has sat
   * for `coalesceMs`, which is what turns a burst into one email. The wait is
   * self-bounding — `oldest` only ages, so a task that never stops changing
   * still emails once per window.
   *
   * `flags->>'task_notifications' = 'true'` is the org gate. It runs here, in
   * SQL, so an org without the flag is never even a candidate and no code path
   * downstream has to remember to check.
   */
  async listDueDigests(
    coalesceMs: number,
    limit: number,
  ): Promise<DigestCandidate[]> {
    const rows = await this.db
      .selectFrom("task_board_subscribers as s")
      .innerJoin("task_board_items as i", "i.id", "s.task_board_item_id")
      .innerJoin(
        "task_board_activity as a",
        "a.task_board_item_id",
        "s.task_board_item_id",
      )
      .innerJoin("member as m", (join) =>
        join
          .onRef("m.userId", "=", "s.user_id")
          .onRef("m.organizationId", "=", "i.organization_id"),
      )
      .innerJoin("user as u", "u.id", "s.user_id")
      .innerJoin("organization as o", "o.id", "i.organization_id")
      .innerJoin(
        "organization_settings as os",
        "os.organizationId",
        "i.organization_id",
      )
      .leftJoin("task_notification_cursors as c", (join) =>
        join
          .onRef("c.user_id", "=", "s.user_id")
          .onRef("c.organization_id", "=", "i.organization_id"),
      )
      .where("s.subscribed", "=", true)
      .whereRef("a.occurred_at", ">=", "s.created_at")
      .where(sql<boolean>`a.actor_id is distinct from s.user_id`)
      .where(
        sql<boolean>`a.occurred_at > coalesce(c.last_emailed_at, '-infinity'::timestamptz)`,
      )
      .where(sql<boolean>`os.flags->>'task_notifications' = 'true'`)
      .groupBy([
        "s.user_id",
        "i.organization_id",
        "u.name",
        "u.email",
        "o.name",
        "o.slug",
        "c.last_emailed_at",
      ])
      .having(
        sql<boolean>`min(a.occurred_at) <= now() - make_interval(secs => ${coalesceMs / 1000})`,
      )
      .select((eb) => [
        "s.user_id as userId",
        "i.organization_id as organizationId",
        "u.name as userName",
        "u.email as userEmail",
        "o.name as organizationName",
        "o.slug as organizationSlug",
        "c.last_emailed_at as lastEmailedAt",
        eb.fn.max("a.occurred_at").as("through"),
        eb.fn.countAll().as("eventCount"),
      ])
      .orderBy("i.organization_id")
      .limit(limit)
      .execute();

    return rows.map((r) => ({
      userId: r.userId,
      userName: r.userName,
      userEmail: r.userEmail,
      organizationId: r.organizationId,
      organizationName: r.organizationName,
      organizationSlug: r.organizationSlug,
      through: new Date(r.through as unknown as string),
      eventCount: Number(r.eventCount),
      lastEmailedAt: r.lastEmailedAt ? new Date(r.lastEmailedAt) : null,
    }));
  }

  /** The events one due digest covers, oldest first (an email reads forwards). */
  async loadDigestEvents(
    userId: string,
    organizationId: string,
    through: Date,
  ): Promise<TaskNotification[]> {
    const rows = await this.pendingQuery(
      userId,
      organizationId,
      "last_emailed_at",
    )
      .select([
        "a.id",
        "a.task_board_item_id",
        "i.title",
        "i.key_seq",
        "a.action",
        "a.actor_id",
        "a.data",
        "a.occurred_at",
      ])
      .where("a.occurred_at", "<=", through)
      .orderBy("a.occurred_at", "asc")
      .execute();
    return (rows as PendingRow[]).map(notificationFromRow);
  }

  /**
   * Claim a digest by advancing the cursor, but only if no other pod moved it
   * first. The cursor row IS the lock — no advisory lock, no claims table.
   * Returns false when someone else won, which the worker treats as "skip".
   *
   * Note `loadDigestEvents` must run AFTER a won claim: it reads the same
   * cursor, so calling it first would return rows the claim then hides.
   */
  async claimDigest(
    userId: string,
    organizationId: string,
    through: Date,
    expected: Date | null,
  ): Promise<boolean> {
    const now = new Date();
    const claimed = await this.db
      .insertInto("task_notification_cursors")
      .values({
        user_id: userId,
        organization_id: organizationId,
        last_emailed_at: through,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(["user_id", "organization_id"])
          .doUpdateSet({ last_emailed_at: through, updated_at: now })
          .where(
            sql<boolean>`task_notification_cursors.last_emailed_at is not distinct from ${expected}`,
          ),
      )
      .returning("user_id")
      .executeTakeFirst();
    return !!claimed;
  }
}
