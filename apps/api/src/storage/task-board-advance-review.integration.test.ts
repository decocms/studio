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

/**
 * Real-Postgres coverage for the failed-run path.
 *
 * The bug this encodes: a failed run advanced its card to In Review, because the
 * thread-finish hook treated every terminal status as "done". Eight tasks whose
 * sandboxes never came up ("Sandbox did not become ready within 180 seconds")
 * landed in the reviewers' lane with no PR and nothing done. In Review means
 * there is something to review, so a failed run must never put a card there —
 * it is retried, or it goes back to To Do.
 *
 * Needs a real database: the retry schedule and the return-to-To-Do are both
 * conditional UPDATEs, and the advance rule is read back through the same
 * `threads`/`thread_message_parts` join the hook uses.
 */
describe("failed runs never reach In Review (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let threads: SqlThreadStorage;

  const ORG2 = "org_failed_run";
  const USER2 = "user_failed_run";

  /** A card In Progress with one linked run in `status`, carrying a message. */
  const cardWithRun = async (title: string, status: string) => {
    const task = await taskBoard.create({
      organizationId: ORG2,
      title,
      status: "in_progress",
      by: USER2,
    });
    const thread = await threads.create({
      organization_id: ORG2,
      title: "Super Agent: run",
      status: status as "completed" | "failed",
      message_storage_version: 2,
      created_by: USER2,
    });
    await taskBoard.linkThread(task.id, thread.id, ORG2);
    await database.db
      .insertInto("thread_message_parts")
      .values({
        id: `${thread.id}:m:0`,
        seq: 0,
        org_id: ORG2,
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

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG2,
        name: ORG2,
        slug: "org-failed-run",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER2}, ${"failed@run.test"}, false, ${USER2}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    threads = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("leaves a card whose only run failed In Progress", async () => {
    const { task, thread } = await cardWithRun("failed run", "failed");

    await taskBoard.advanceLinkedTasksToReviewOnThreadFinish(thread.id, ORG2);

    expect((await taskBoard.getById(task.id, ORG2))?.status).toBe(
      "in_progress",
    );
  });

  it("reads the failure kind and the run's error text together", async () => {
    const { thread } = await cardWithRun("with error part", "failed");
    await database.db
      .updateTable("threads")
      .set({ failure_kind: "error" })
      .where("id", "=", thread.id)
      .execute();
    await database.db
      .insertInto("thread_message_parts")
      .values({
        id: `${thread.id}:m:1`,
        seq: 1,
        org_id: ORG2,
        thread_id: thread.id,
        run_id: thread.id,
        message_id: `${thread.id}:m`,
        role: "assistant",
        kind: "error",
        payload: JSON.stringify({
          type: "text",
          text: "Error: Sandbox did not become ready within 180 seconds",
        }),
        created_at: new Date().toISOString(),
      })
      .execute();

    const info = await taskBoard.failedRunInfo(thread.id, ORG2);

    expect(info?.kind).toBe("error");
    expect(info?.errorText).toContain("did not become ready");
  });

  it("does not report a failure for a run that completed", async () => {
    const { thread } = await cardWithRun("completed run", "completed");
    expect(await taskBoard.failedRunInfo(thread.id, ORG2)).toBeNull();
  });

  it("schedules a retry that only one sweeper can claim", async () => {
    const { task } = await cardWithRun("retry me", "failed");
    const due = new Date(Date.now() - 1000);

    expect(await taskBoard.scheduleRunRetry(task.id, ORG2, 1, due)).toBe(true);
    expect((await taskBoard.getById(task.id, ORG2))?.retryAttempts).toBe(1);
    expect(
      (await taskBoard.listItemsDueForRetry(10, new Date())).map((r) => r.id),
    ).toContain(task.id);

    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        taskBoard.claimDueRetry(task.id, ORG2, new Date()),
      ),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  // The floor for a failure whose reaction never ran (pod died between
  // `markRunFailed` and the hook). Without it, such a card is In Progress with a
  // dead run, no retry armed, and — now that a failed run no longer advances —
  // nothing at all looking at it.
  it("finds a card stuck after a failure nobody reacted to", async () => {
    const { task, thread } = await cardWithRun("nobody reacted", "failed");
    // Age the failure past the grace window the sweeper waits out.
    await database.db
      .updateTable("threads")
      .set({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .where("id", "=", thread.id)
      .execute();
    // Only Super Agent cards are the sweeper's business.
    await database.db
      .updateTable("task_board_items")
      .set({ assignee_id: "super-agent" })
      .where("id", "=", task.id)
      .execute();

    const stuck = await taskBoard.listItemsStuckAfterFailure(10, new Date());

    expect(stuck.map((s) => s.id)).toContain(task.id);
    expect(stuck.find((s) => s.id === task.id)?.threadId).toBe(thread.id);
  });

  it("ignores a stuck-looking card that already has a retry armed", async () => {
    const { task, thread } = await cardWithRun("already armed", "failed");
    await database.db
      .updateTable("threads")
      .set({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .where("id", "=", thread.id)
      .execute();
    await database.db
      .updateTable("task_board_items")
      .set({ assignee_id: "super-agent" })
      .where("id", "=", task.id)
      .execute();
    await taskBoard.scheduleRunRetry(
      task.id,
      ORG2,
      1,
      new Date(Date.now() + 60_000),
    );

    const stuck = await taskBoard.listItemsStuckAfterFailure(10, new Date());

    expect(stuck.map((s) => s.id)).not.toContain(task.id);
  });

  it("ignores a card whose sibling run is still working", async () => {
    const { task, thread } = await cardWithRun("sibling live", "failed");
    await database.db
      .updateTable("threads")
      .set({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .where("id", "=", thread.id)
      .execute();
    await database.db
      .updateTable("task_board_items")
      .set({ assignee_id: "super-agent" })
      .where("id", "=", task.id)
      .execute();
    const live = await threads.create({
      organization_id: ORG2,
      title: "Super Agent: retry",
      status: "in_progress",
      message_storage_version: 2,
      created_by: USER2,
    });
    await taskBoard.linkThread(task.id, live.id, ORG2);

    const stuck = await taskBoard.listItemsStuckAfterFailure(10, new Date());

    expect(stuck.map((s) => s.id)).not.toContain(task.id);
  });

  // The gap that stranded a card's reviewers: a reviewer thread whose dispatch
  // never landed stayed `in_progress`, read as a live review, and blocked that
  // reviewer's retry for the whole cycle. Nothing reaped it — the board-open
  // recovery only looked at cards parked In Progress.
  it("fails a never-started thread on ANY lane, and says which card", async () => {
    const { task, thread } = await cardWithRun("never dispatched", "completed");
    await database.db
      .updateTable("threads")
      .set({
        status: "in_progress",
        run_started_at: null,
        last_progress_at: null,
        updated_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      })
      .where("id", "=", thread.id)
      .execute();
    // In Review — the lane the old reaper skipped.
    await database.db
      .updateTable("task_board_items")
      .set({ status: "in_review" })
      .where("id", "=", task.id)
      .execute();

    const reaped = await taskBoard.failNeverStartedLinkedThreads(
      10,
      new Date(Date.now() - 30 * 60_000),
      "never started",
    );

    expect(reaped.map((r) => r.threadId)).toContain(thread.id);
    expect(reaped.find((r) => r.threadId === thread.id)?.itemId).toBe(task.id);
  });

  it("leaves a run that actually STARTED to the idle reaper", async () => {
    const { thread } = await cardWithRun("started then quiet", "completed");
    await database.db
      .updateTable("threads")
      .set({
        status: "in_progress",
        run_started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        updated_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      })
      .where("id", "=", thread.id)
      .execute();

    const reaped = await taskBoard.failNeverStartedLinkedThreads(
      10,
      new Date(Date.now() - 30 * 60_000),
      "never started",
    );

    expect(reaped.map((r) => r.threadId)).not.toContain(thread.id);
  });

  it("leaves a fresh never-started thread alone (it may still be dispatching)", async () => {
    const { thread } = await cardWithRun("just enqueued", "completed");
    await database.db
      .updateTable("threads")
      .set({
        status: "in_progress",
        run_started_at: null,
        last_progress_at: null,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", thread.id)
      .execute();

    const reaped = await taskBoard.failNeverStartedLinkedThreads(
      10,
      new Date(Date.now() - 30 * 60_000),
      "never started",
    );

    expect(reaped.map((r) => r.threadId)).not.toContain(thread.id);
  });

  it("sends an exhausted card back to To Do and clears its retry state", async () => {
    const { task } = await cardWithRun("out of retries", "failed");
    await taskBoard.scheduleRunRetry(task.id, ORG2, 3, new Date());

    const returned = await taskBoard.returnToTodoAfterFailure(
      task.id,
      ORG2,
      USER2,
    );

    expect(returned?.status).toBe("todo");
    expect(returned?.retryAttempts).toBe(0);
    // A card that already left In Progress is not dragged backwards.
    expect(
      await taskBoard.returnToTodoAfterFailure(task.id, ORG2, USER2),
    ).toBeNull();
  });
});
