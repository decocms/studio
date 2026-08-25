/**
 * The one writer of notifications.
 *
 * Subscriber lookup, auto-subscribe, actor exclusion, payload validation and
 * error swallowing all live here, so a new call site cannot get them wrong.
 * A comment that saved but didn't notify is a bug; a comment that failed to
 * save because of a notification is an outage — so this never throws.
 */

import type { Kysely } from "kysely";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { NotificationType } from "@decocms/shared/notification-types";
import type { Database } from "@/storage/types";
import { NotificationDataSchema } from "./schema";

export interface NotifyParams {
  db: Kysely<Database>;
  taskBoardItemId: string;
  type: NotificationType;
  /** Null = agent/system. Never notified of their own action. */
  actorId: string | null;
  /** Users this event enrolls. A muted subscription stays muted. */
  alsoSubscribe?: (string | null | undefined)[];
}

/** The task's org and title, which `recordActivity` doesn't carry. */
async function loadSubject(db: Kysely<Database>, taskBoardItemId: string) {
  return await db
    .selectFrom("task_board_items")
    .select(["organization_id", "title", "key_seq"])
    .where("id", "=", taskBoardItemId)
    .executeTakeFirst();
}

async function loadActor(db: Kysely<Database>, actorId: string | null) {
  if (!actorId) return { name: null, image: null };
  const row = await db
    .selectFrom("user")
    .select(["name", "image"])
    .where("id", "=", actorId)
    .executeTakeFirst();
  return { name: row?.name ?? null, image: row?.image ?? null };
}

export async function notify(params: NotifyParams): Promise<void> {
  const { db, taskBoardItemId, type, actorId } = params;
  try {
    const subject = await loadSubject(db, taskBoardItemId);
    if (!subject) return;

    // Reentrancy guard: Kysely can't nest a caller's transaction handle.
    const run = async (tx: Kysely<Database>) => {
      const enroll = [
        ...new Set(params.alsoSubscribe?.filter((id): id is string => !!id)),
      ];
      if (enroll.length > 0) {
        await tx
          .insertInto("notification_subscriptions")
          .values(
            enroll.map((userId) => ({
              id: generatePrefixedId("nsub"),
              user_id: userId,
              task_board_item_id: taskBoardItemId,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["user_id", "task_board_item_id"]).doNothing(),
          )
          .execute();
      }

      const subscribers = await tx
        .selectFrom("notification_subscriptions")
        .select("user_id")
        .where("task_board_item_id", "=", taskBoardItemId)
        .where("subscribed", "=", true)
        .execute();

      const recipients = subscribers
        .map((row) => row.user_id)
        .filter((userId) => userId !== actorId);
      if (recipients.length === 0) return;

      const actor = await loadActor(tx, actorId);
      const data = NotificationDataSchema.parse({
        taskTitle: subject.title,
        taskKeySeq: subject.key_seq ?? null,
        actorName: actor.name,
        actorImage: actor.image,
      });

      await tx
        .insertInto("notifications")
        .values(
          recipients.map((userId) => ({
            id: generatePrefixedId("notif"),
            user_id: userId,
            organization_id: subject.organization_id,
            task_board_item_id: taskBoardItemId,
            type,
            actor_id: actorId,
            data: JSON.stringify(data),
          })),
        )
        .execute();
    };
    await (db.isTransaction ? run(db) : db.transaction().execute(run));
  } catch (err) {
    console.error("[notifications] fan-out failed", err);
  }
}
