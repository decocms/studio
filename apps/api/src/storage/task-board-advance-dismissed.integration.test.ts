/**
 * Real-Postgres coverage for `advanceToReviewIfInProgress` excluding
 * dismissed cards.
 *
 * Same bug class as `task-board-due-retry.integration.test.ts`: a
 * reports-pushed task's `delete()` only stamps `dismissed_at` (it keeps the
 * row so the next diagnostic import doesn't recreate the card) — it never
 * touches `status`. Without a `dismissed_at IS NULL` guard here, a dismissed
 * card whose linked thread finishes afterward gets resurrected straight into
 * the reviewers' lane via `advanceLinkedTasksToReviewOnThreadFinish`.
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

const ORG = "org_advance_dismissed";
const USER = "user_advance_dismissed";

describe("advanceToReviewIfInProgress (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-advance-dismissed",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"advance-dismissed@test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("advances a normal in-progress card to in_review", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "normal advance",
      status: "in_progress",
      by: USER,
    });

    const advanced = await taskBoard.advanceToReviewIfInProgress(
      task.id,
      ORG,
      USER,
    );

    expect(advanced?.status).toBe("in_review");
  });

  it("does not advance a reports card dismissed while still in_progress", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "dismissed while in progress",
      status: "in_progress",
      by: "system",
    });

    // Mirrors TASK_BOARD_ITEM_DELETE on a reports task: dismissed_at only.
    await taskBoard.delete(task.id, ORG, USER);
    const row = await database.db
      .selectFrom("task_board_items")
      .select("dismissed_at")
      .where("id", "=", task.id)
      .executeTakeFirst();
    expect(row?.dismissed_at).toBeTruthy();

    const advanced = await taskBoard.advanceToReviewIfInProgress(
      task.id,
      ORG,
      USER,
    );

    expect(advanced).toBeNull();
  });
});
