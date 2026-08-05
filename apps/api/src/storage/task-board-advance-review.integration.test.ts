/**
 * Real-Postgres coverage for the atomic In Review advance.
 *
 * The bug this encodes: the advance was a non-atomic read-then-write, and
 * `recoverStalledTasks` runs fire-and-forget on EVERY `TASK_BOARD_ITEM_LIST`
 * over the snapshot that read already loaded. N overlapping board reads each saw
 * `in_progress` and each wrote — one prod item collected 42 duplicate
 * `status_changed→in_review` rows, another 27 inside 112 ms.
 *
 * The duplicate row was not the damage; the duplicate ACTIVITY was.
 * `reviewCycleStart` treats the newest `→in_review` stamp as the start of the
 * current review cycle, so each redundant stamp invalidated every approval
 * before it — the verified-approval gate stopped seeing a complete set,
 * auto-merge never fired, and the card sat In Review forever. All 13 prod items
 * holding an approval were stranded exactly this way.
 *
 * Only a real database can prove the fix: the guard is a SQL predicate, and the
 * concurrency is what makes it necessary, so both are exercised here.
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
import { SqlThreadStorage } from "./threads";

const ORG = "org_advance_review";
const USER = "user_advance_review";

describe("advanceToReviewIfInProgress (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let threads: SqlThreadStorage;

  /** A card In Progress with one finished, message-carrying run linked. */
  const cardWithFinishedRun = async (title: string) => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title,
      status: "in_progress",
      by: USER,
    });
    const thread = await threads.create({
      organization_id: ORG,
      title: "Super Agent: run",
      status: "completed",
      message_storage_version: 2,
      created_by: USER,
    });
    await taskBoard.linkThread(task.id, thread.id, ORG);
    // `hasMessages` is what separates a real run from an empty chat, and
    // `shouldAdvanceToReview` filters on it.
    await database.db
      .insertInto("thread_message_parts")
      .values({
        id: `${thread.id}:m:0`,
        seq: 0,
        org_id: ORG,
        thread_id: thread.id,
        run_id: thread.id,
        message_id: `${thread.id}:m`,
        role: "user",
        kind: "text",
        payload: JSON.stringify({ type: "text", text: "go" }),
        created_at: new Date().toISOString(),
      })
      .execute();
    return { task, thread };
  };

  const inReviewStamps = async (taskId: string) => {
    const rows = await database.db
      .selectFrom("task_board_activity")
      .select(["id"])
      .where("task_board_item_id", "=", taskId)
      .where("action", "=", "status_changed")
      .where(sql`data->>'to'`, "=", "in_review")
      .execute();
    return rows.length;
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-advance-review",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"advance@review.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    threads = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("advances an in_progress card and returns it", async () => {
    const { task } = await cardWithFinishedRun("advance me");

    const advanced = await taskBoard.advanceToReviewIfInProgress(
      task.id,
      ORG,
      USER,
    );

    expect(advanced?.status).toBe("in_review");
  });

  it("returns null for a card that already left in_progress", async () => {
    const { task } = await cardWithFinishedRun("already moved");
    await taskBoard.advanceToReviewIfInProgress(task.id, ORG, USER);

    // Second caller loses — this is the guard that stops the duplicate stamp.
    expect(
      await taskBoard.advanceToReviewIfInProgress(task.id, ORG, USER),
    ).toBeNull();
  });

  it("is org-scoped — another org cannot advance the card", async () => {
    const { task } = await cardWithFinishedRun("cross-org");

    expect(
      await taskBoard.advanceToReviewIfInProgress(task.id, "org_other", USER),
    ).toBeNull();
    expect((await taskBoard.getById(task.id, ORG))?.status).toBe("in_progress");
  });

  // Wiring, NOT a proof of the race: with real DB round-trips these 10 chains
  // interleave, so most of their reads land after the first write and the OLD
  // unguarded code passes this too. It's kept because it pins the caller to the
  // guarded primitive and to one activity row per won flip. The deterministic
  // proof that the guard works is the two tests above — both fail if the
  // `where status = 'in_progress'` predicate is removed.
  it("records exactly ONE in_review stamp across 10 advance passes", async () => {
    const { task, thread } = await cardWithFinishedRun("stampede");

    await Promise.all(
      Array.from({ length: 10 }, () =>
        taskBoard.advanceLinkedTasksToReviewOnThreadFinish(thread.id, ORG),
      ),
    );

    expect((await taskBoard.getById(task.id, ORG))?.status).toBe("in_review");
    // In prod this reached 42 on one card — and every approval older than the
    // last stamp was invalidated by it.
    expect(await inReviewStamps(task.id)).toBe(1);
  });

  it("only one of N concurrent callers is told it won the flip", async () => {
    const { task } = await cardWithFinishedRun("single winner");

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        taskBoard.advanceToReviewIfInProgress(task.id, ORG, USER),
      ),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});
