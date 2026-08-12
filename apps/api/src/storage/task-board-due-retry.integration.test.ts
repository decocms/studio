/**
 * Real-Postgres coverage for `listItemsDueForRetry` excluding dismissed cards.
 *
 * The bug this encodes: a reports-pushed task's `delete()` only stamps
 * `dismissed_at` (it keeps the row so the next diagnostic import doesn't
 * recreate the card) — it never touches `status`/`retry_at`. Without a
 * `dismissed_at IS NULL` filter here, a card whose retry was already armed
 * when the user dismissed it stays visible to the review sweeper's retry
 * pass, which dispatches a brand-new Super Agent run against a card the user
 * already removed from the board.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";

const ORG = "org_due_retry";
const USER = "user_due_retry";

describe("listItemsDueForRetry (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;

  const dueRetryCard = async (title: string, by: string) => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title,
      status: "in_progress",
      by,
    });
    const claimed = await taskBoard.scheduleRunRetry(
      task.id,
      ORG,
      1,
      new Date(Date.now() - 1000),
    );
    expect(claimed).toBe(true);
    return task;
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-due-retry",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"due-retry@test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("returns a due card created by a normal user", async () => {
    const task = await dueRetryCard("normal retry", USER);

    const due = await taskBoard.listItemsDueForRetry(50, new Date());

    expect(due.map((r) => r.id)).toContain(task.id);
  });

  it("excludes a reports card dismissed while its retry was still armed", async () => {
    const task = await dueRetryCard("dismissed while pending", "system");

    // Mirrors TASK_BOARD_ITEM_DELETE on a reports task: stamps dismissed_at only.
    await taskBoard.delete(task.id, ORG, USER);
    const row = await database.db
      .selectFrom("task_board_items")
      .select("dismissed_at")
      .where("id", "=", task.id)
      .executeTakeFirst();
    expect(row?.dismissed_at).toBeTruthy();

    const due = await taskBoard.listItemsDueForRetry(50, new Date());

    expect(due.map((r) => r.id)).not.toContain(task.id);
  });
});
