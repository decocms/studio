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
