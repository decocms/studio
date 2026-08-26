import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { TaskBoardStorage } from "../storage/task-board";
import { NotificationStorage } from "../storage/notifications";
import { notify } from "./notify";
import { claimForEmail, setNotificationDigestRuntime } from "./dbos-digest";

describe("notifications", () => {
  let database: StudioDatabase;
  let tasks: TaskBoardStorage;
  let store: NotificationStorage;
  let itemId: string;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    tasks = new TaskBoardStorage(database.db);
    store = new NotificationStorage(database.db);
    itemId = (
      await tasks.create({
        organizationId: "org_test",
        title: "Followed task",
        by: "user_test",
      })
    ).id;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("rejects a type the CHECK constraint doesn't allow", async () => {
    const insert = sql`
      INSERT INTO notifications (id, user_id, organization_id, task_board_item_id, type, data)
      VALUES ('notif_bad', 'user_1', 'org_test', ${itemId}, 'exploded', '{}'::jsonb)
    `.execute(database.db);
    expect(insert).rejects.toThrow();
  });

  it("notifies followers but never the actor", async () => {
    await store.setSubscribed("user_1", itemId, true);
    await store.setSubscribed("user_123", itemId, true);

    await notify({
      db: database.db,
      taskBoardItemId: itemId,
      type: "commented",
      actorId: "user_1",
    });

    expect((await store.listUnread("user_1", "org_test")).unreadCount).toBe(0);
    const mine = await store.listUnread("user_123", "org_test");
    expect(mine.unreadCount).toBe(1);
    expect(mine.notifications[0]!.data.taskTitle).toBe("Followed task");
    expect(mine.notifications[0]!.data.actorName).toBe("Test user_1");
  });

  it("alsoSubscribe never un-mutes a deliberate unfollow", async () => {
    await store.setSubscribed("user_test", itemId, false);
    await notify({
      db: database.db,
      taskBoardItemId: itemId,
      type: "status_changed",
      actorId: "user_1",
      alsoSubscribe: ["user_test"],
    });
    expect((await store.listUnread("user_test", "org_test")).unreadCount).toBe(
      0,
    );
  });

  it("lists newest first, skips read rows, and marks read idempotently", async () => {
    await notify({
      db: database.db,
      taskBoardItemId: itemId,
      type: "status_changed",
      actorId: null,
    });
    // 3: the comment, the muted-subscription test's status_changed, and this one.
    const before = await store.listUnread("user_123", "org_test");
    expect(before.unreadCount).toBe(3);
    expect(before.notifications[0]!.type).toBe("status_changed");

    expect(await store.markRead("user_123", "org_test")).toBe(3);
    expect(await store.markRead("user_123", "org_test")).toBe(0);
    expect((await store.listUnread("user_123", "org_test")).unreadCount).toBe(
      0,
    );
  });

  it("scopes a user's inbox to one org at a time", async () => {
    const other = await tasks.create({
      organizationId: "org_1",
      title: "Other org task",
      by: "user_test",
    });
    await store.setSubscribed("user_123", other.id, true);
    await notify({
      db: database.db,
      taskBoardItemId: other.id,
      type: "created",
      actorId: "user_1",
    });

    expect((await store.listUnread("user_123", "org_test")).unreadCount).toBe(
      0,
    );
    expect((await store.listUnread("user_123", "org_1")).unreadCount).toBe(1);
  });

  it("claims rows for email exactly once, so two senders can't double-mail", async () => {
    setNotificationDigestRuntime({ db: database.db });
    const task = await tasks.create({
      organizationId: "org_test",
      title: "Claimed",
      by: "user_test",
    });
    await store.setSubscribed("user_123", task.id, true);
    await notify({
      db: database.db,
      taskBoardItemId: task.id,
      type: "commented",
      actorId: null,
    });
    const ids = (await store.listUnread("user_123", "org_test")).notifications
      .filter((n) => n.taskBoardItemId === task.id)
      .map((n) => n.id);
    expect(ids).toHaveLength(1);

    // The sweep and the per-user workflow reaching for the same row.
    const [first, second] = await Promise.all([
      claimForEmail(ids),
      claimForEmail(ids),
    ]);
    expect(first.size + second.size).toBe(1);
  });

  it("notifies the user an event enrolls, not just prior followers", async () => {
    // What "assigning someone notifies them" rests on: the enroll happens
    // before the subscriber lookup, so the new assignee gets THIS event and not
    // merely the next one.
    const task = await tasks.create({
      organizationId: "org_test",
      title: "Assigned to you",
      by: "user_test",
    });
    await notify({
      db: database.db,
      taskBoardItemId: task.id,
      type: "assignee_changed",
      actorId: "user_test",
      alsoSubscribe: ["user_1"],
    });

    const inbox = await store.listUnread("user_1", "org_test");
    expect(
      inbox.notifications.some(
        (n) => n.taskBoardItemId === task.id && n.type === "assignee_changed",
      ),
    ).toBe(true);
  });

  it("pages by keyset, so rows read between pages can't shift the window", async () => {
    const task = await tasks.create({
      organizationId: "org_test",
      title: "Paged",
      by: "user_test",
    });
    await store.setSubscribed("user_test", task.id, true);
    // One burst, one transaction each — several rows share a created_at, which
    // is exactly the tie an id-less cursor loses rows on.
    for (let i = 0; i < 5; i++) {
      await notify({
        db: database.db,
        taskBoardItemId: task.id,
        type: "commented",
        actorId: null,
      });
    }

    // One statement, one `now()`: every row shares a created_at to the
    // microsecond, so paging has nothing but `id` left to order by. This is
    // what a millisecond-truncated cursor silently drops rows on.
    await sql`UPDATE notifications SET created_at = now()
      WHERE task_board_item_id = ${task.id}`.execute(database.db);

    const first = await store.listUnread("user_test", "org_test", { limit: 2 });
    expect(first.notifications).toHaveLength(2);
    expect(first.unreadCount).toBe(5);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.listUnread("user_test", "org_test", {
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await store.listUnread("user_test", "org_test", {
      limit: 2,
      cursor: second.nextCursor!,
    });

    const ids = [first, second, third]
      .flatMap((page) => page.notifications)
      .map((n) => n.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it("cascades subscriptions and notifications when the task is deleted", async () => {
    const doomed = await tasks.create({
      organizationId: "org_test",
      title: "Doomed",
      by: "user_test",
    });
    await store.setSubscribed("user_123", doomed.id, true);
    await notify({
      db: database.db,
      taskBoardItemId: doomed.id,
      type: "created",
      actorId: "user_1",
    });
    await tasks.delete(doomed.id, "org_test", "user_test");

    const left = await database.db
      .selectFrom("notifications")
      .select("id")
      .where("task_board_item_id", "=", doomed.id)
      .execute();
    expect(left).toHaveLength(0);
    expect(await store.listSubscribers(doomed.id)).toHaveLength(0);
  });
});
