import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { NotificationStorage } from "./notifications";
import { TaskBoardStorage } from "./task-board";

/**
 * Real-Postgres coverage for the `duplicate_reported` activity action that
 * `TASK_BOARD_ITEM_CREATE`'s `onDuplicate: "return_existing"` writes.
 *
 * The action set is enforced by a CHECK constraint the newest migration
 * (219) replaces. `activity-actions.test.ts` proves the TS list and that
 * migration's list agree; this proves the constraint actually live in the
 * database accepts the insert, which is what a stale or unregistered
 * migration would break at runtime and nothing else catches.
 */
const ORG = "org_duplicate_reported_1";
const USER = "user_duplicate_reported";
const FILER = "user_duplicate_filer";

describe("TaskBoardStorage — duplicate_reported activity", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;
  let notifications: NotificationStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const createdAt = new Date().toISOString();
    for (const id of [USER, FILER]) {
      await sql`
        INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
        VALUES (${id}, ${`${id}@test.com`}, false, ${id}, ${createdAt}, ${createdAt})
      `.execute(database.db);
    }
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "duplicate-reported-one", createdAt })
      .execute();
    storage = new TaskBoardStorage(database.db);
    notifications = new NotificationStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("the CHECK constraint accepts the action and the entry reads back with its payload", async () => {
    const item = await storage.create({
      organizationId: ORG,
      title: "Checkout button unclickable on Safari",
      by: USER,
    });

    await storage.recordActivity({
      taskBoardItemId: item.id,
      action: "duplicate_reported",
      actorId: FILER,
      data: { title: "Safari: can't click checkout", reason: "Same bug." },
    });

    const entries = await storage.listActivity(item.id, ORG);
    const reported = entries.find((e) => e.action === "duplicate_reported");
    expect(reported).toBeDefined();
    expect(reported?.actorId).toBe(FILER);
    expect(reported?.data).toEqual({
      title: "Safari: can't click checkout",
      reason: "Same bug.",
    });
  });

  it("earns no inbox row for the card's followers", async () => {
    const item = await storage.create({
      organizationId: ORG,
      title: "Followed card",
      by: USER,
    });
    await notifications.setSubscribed(USER, item.id, true);

    await storage.recordActivity({
      taskBoardItemId: item.id,
      action: "duplicate_reported",
      actorId: FILER,
      data: { title: "again", reason: "dup" },
    });

    const rows = await database.db
      .selectFrom("notifications")
      .selectAll()
      .where("task_board_item_id", "=", item.id)
      .execute();
    expect(rows).toHaveLength(0);
  });
});
