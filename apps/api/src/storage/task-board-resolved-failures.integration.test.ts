/**
 * Real-Postgres coverage for the two failure relabels — `failed` rows whose
 * failure is not the task's outcome.
 *
 * 236 of the 307 failed task-board threads in one prod month sat on cards that
 * reached In Review or Done: a run that posted its comment, pushed its PR and
 * moved the card itself, then lost its stream, and every superseded attempt of a
 * card a later attempt finished. Both rendered as a red "Error" the user could
 * not act on, and one of them ("Run ended with an error — see the run's
 * messages") pointed at an error part that did not exist.
 *
 * The gates are SQL predicates — which rows move, which keep their kind, and
 * which card they belong to — so only a real database proves them.
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
import type { ThreadStatus } from "@decocms/shared/entities";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

const ORG = "org_resolved_failures";
const USER = "user_resolved_failures";

describe("relabelDeliveredFailure / supersedeFailedThreads (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let threads: SqlThreadStorage;

  const linkedThread = async (
    taskId: string,
    status: ThreadStatus,
    failureKind?: string,
  ) => {
    const thread = await threads.create({
      organization_id: ORG,
      title: "Super Agent: run",
      status,
      message_storage_version: 2,
      created_by: USER,
    });
    if (failureKind) {
      await database.db
        .updateTable("threads")
        .set({ failure_kind: failureKind, failure_reason: "whatever" })
        .where("id", "=", thread.id)
        .execute();
    }
    await taskBoard.linkThread(taskId, thread.id, ORG);
    return thread.id;
  };

  const kindOf = async (threadId: string) => {
    const row = await database.db
      .selectFrom("threads")
      .select(["failure_kind", "failure_reason", "status"])
      .where("id", "=", threadId)
      .executeTakeFirst();
    return row;
  };

  const card = (title: string, status: "in_progress" | "in_review") =>
    taskBoard.create({ organizationId: ORG, title, status, by: USER });

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-resolved-failures",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"resolved-failures@test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    threads = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("relabels a failed run, keeping it failed", async () => {
    const task = await card("delivered then died", "in_review");
    const threadId = await linkedThread(task.id, "failed", "error");

    expect(
      await taskBoard.relabelDeliveredFailure(threadId, ORG, "delivered first"),
    ).toBe(true);

    const row = await kindOf(threadId);
    expect(row?.failure_kind).toBe("ended_after_delivery");
    expect(row?.failure_reason).toBe("delivered first");
    // The run really did die — only the explanation changes.
    expect(row?.status).toBe("failed");
  });

  it("leaves a completed run and a cancelled failure alone", async () => {
    const task = await card("nothing to relabel", "in_review");
    const completed = await linkedThread(task.id, "completed");
    const cancelled = await linkedThread(task.id, "failed", "cancelled");

    expect(
      await taskBoard.relabelDeliveredFailure(completed, ORG, "nope"),
    ).toBe(false);
    expect(
      await taskBoard.relabelDeliveredFailure(cancelled, ORG, "nope"),
    ).toBe(false);
    expect((await kindOf(cancelled))?.failure_kind).toBe("cancelled");
  });

  it("supersedes only the card's own failed threads", async () => {
    const task = await card("retried card", "in_progress");
    const failed = await linkedThread(task.id, "failed", "error");
    const cancelled = await linkedThread(task.id, "failed", "cancelled");
    const live = await linkedThread(task.id, "in_progress");
    const other = await card("someone else's card", "in_progress");
    const otherFailed = await linkedThread(other.id, "failed", "error");

    expect(await taskBoard.supersedeFailedThreads(task.id, ORG)).toBe(1);

    expect((await kindOf(failed))?.failure_kind).toBe("superseded");
    // A human cancelled this one on purpose — they keep seeing that.
    expect((await kindOf(cancelled))?.failure_kind).toBe("cancelled");
    // The attempt being dispatched is `in_progress`, so it is never touched.
    expect((await kindOf(live))?.failure_kind).toBeNull();
    expect((await kindOf(otherFailed))?.failure_kind).toBe("error");
  });

  it("exposes the kind on the card so the board can render it muted", async () => {
    const task = await card("board render", "in_review");
    await linkedThread(task.id, "failed", "error");
    await taskBoard.supersedeFailedThreads(task.id, ORG);

    const item = await taskBoard.getById(task.id, ORG);
    expect(item?.threads.map((t) => t.failureKind)).toEqual(["superseded"]);
  });

  it("keeps a superseded failure out of the stuck-after-failure sweep", async () => {
    const task = await card("mid-retry", "in_progress");
    const threadId = await linkedThread(task.id, "failed", "error");
    await database.db
      .updateTable("task_board_items")
      .set({ assignee_id: SUPER_AGENT_ASSIGNEE_ID })
      .where("id", "=", task.id)
      .execute();
    const staleBefore = new Date(Date.now() + 60_000);

    const before = await taskBoard.listItemsStuckAfterFailure(50, staleBefore);
    expect(before.map((r) => r.threadId)).toContain(threadId);

    await taskBoard.supersedeFailedThreads(task.id, ORG);

    const after = await taskBoard.listItemsStuckAfterFailure(50, staleBefore);
    expect(after.map((r) => r.threadId)).not.toContain(threadId);
  });
});
