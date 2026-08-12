/**
 * Real-Postgres coverage for `scheduleRunRetry`/`returnToTodoAfterFailure`
 * excluding dismissed cards.
 *
 * Same bug class as `task-board-advance-dismissed.integration.test.ts`: a
 * reports-pushed task's `delete()` only stamps `dismissed_at` and leaves
 * `status` at `in_progress`. `reactToFailedTaskRun`/the review sweeper decide
 * whether to react off that stale `status` (read via `getById`, which doesn't
 * expose `dismissedAt`) — without a `dismissed_at IS NULL` guard here, a card
 * dismissed while its run was still in flight gets a fresh retry armed, or
 * gets resurrected back onto To Do, once that run finally fails.
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

const ORG = "org_retry_dismissed";
const USER = "user_retry_dismissed";

describe("scheduleRunRetry / returnToTodoAfterFailure (real Postgres)", () => {
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
        slug: "org-retry-dismissed",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"retry-dismissed@test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("arms a retry on a normal in-progress card", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "normal retry",
      status: "in_progress",
      by: USER,
    });

    const scheduled = await taskBoard.scheduleRunRetry(
      task.id,
      ORG,
      1,
      new Date(Date.now() + 1000),
    );

    expect(scheduled).toBe(true);
  });

  it("does not arm a retry on a card dismissed while still in_progress", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "dismissed before retry",
      status: "in_progress",
      by: "system",
    });

    // Mirrors TASK_BOARD_ITEM_DELETE on a reports task: dismissed_at only.
    await taskBoard.delete(task.id, ORG, USER);

    const scheduled = await taskBoard.scheduleRunRetry(
      task.id,
      ORG,
      1,
      new Date(Date.now() + 1000),
    );

    expect(scheduled).toBe(false);
  });

  it("returns a normal in-progress card to todo after failure", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "normal return to todo",
      status: "in_progress",
      by: USER,
    });

    const returned = await taskBoard.returnToTodoAfterFailure(
      task.id,
      ORG,
      USER,
    );

    expect(returned?.status).toBe("todo");
  });

  it("does not resurrect a card dismissed while still in_progress onto todo", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "dismissed before return to todo",
      status: "in_progress",
      by: "system",
    });

    await taskBoard.delete(task.id, ORG, USER);

    const returned = await taskBoard.returnToTodoAfterFailure(
      task.id,
      ORG,
      USER,
    );

    expect(returned).toBeNull();
  });
});
