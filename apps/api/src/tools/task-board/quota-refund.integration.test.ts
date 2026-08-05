/**
 * Real-Postgres coverage for the ONE site that refunds a task-quota charge:
 * `advanceTasksToReviewOnThreadFinish` → `refundUnproductiveTaskClaims`.
 *
 * This is the wiring the storage-level quota tests can't see. Every case here
 * is a fact the decision must key on — a PR row, the card's lane, a sibling
 * thread still running — rather than "did we observe a PR-open event".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { OrganizationBillingStorage } from "../../storage/organization-billing";
import { TaskBoardStorage } from "../../storage/task-board";
import { SqlThreadStorage } from "../../storage/threads";
import {
  claimTaskExecution,
  type TaskQuotaConfig,
} from "../../billing/task-quota";
import { advanceTasksToReviewOnThreadFinish } from "./run-reactions";

const ORG = "org_refund_wiring";
const USER = "user_refund_wiring";

const CONFIG: TaskQuotaConfig = {
  enforced: true,
  freeTaskExecutions: 10,
  monthlyTaskExecutions: 10,
  maxRunsPerTask: 5,
};

describe("quota refund on thread finish (wiring)", () => {
  let database: StudioDatabase;
  let billing: OrganizationBillingStorage;
  let taskBoard: TaskBoardStorage;
  let threads: SqlThreadStorage;
  let ctx: StudioContext;

  const stateOf = async (taskId: string) =>
    (await billing.taskClaim(taskId))?.state ?? null;

  /** A task with one charged claim and one thread carrying a message. */
  const chargedTask = async (
    title: string,
    threadStatus: "completed" | "in_progress",
  ) => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title,
      status: "in_progress",
      by: "system",
    });
    await claimTaskExecution(ctx, task, CONFIG);
    const thread = await addThread(task.id, threadStatus);
    return { task, thread };
  };

  const addThread = async (
    taskId: string,
    status: "completed" | "in_progress",
  ) => {
    const thread = await threads.create({
      organization_id: ORG,
      title: "run",
      status,
      message_storage_version: 2,
      created_by: USER,
    });
    await taskBoard.linkThread(taskId, thread.id, ORG);
    // `hasMessages` is what separates a real run from an empty chat.
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
    return thread;
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-refund-wiring",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await database.db
      .insertInto("organization_billing")
      .values({ organization_id: ORG })
      .execute();
    // threads.created_by is a real FK — the runs need an actual user row.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"refund@wiring.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    billing = new OrganizationBillingStorage(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    threads = new SqlThreadStorage(database.db);
    ctx = {
      organization: { id: ORG, slug: "org-refund-wiring", name: ORG },
      storage: { organizationBilling: billing, taskBoard },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("refunds a finished run that produced nothing", async () => {
    const { task, thread } = await chargedTask("nothing", "completed");
    // The advance half moves it to In Review (a repo-less answer IS the
    // deliverable) — so seed a card the advance can't take: no PR, and the
    // card pulled out of In Progress the way a human drag would leave it.
    await taskBoard.update(task.id, ORG, { status: "todo" }, "system");

    await advanceTasksToReviewOnThreadFinish(
      taskBoard,
      thread.id,
      ORG,
      billing,
    );

    expect(await stateOf(task.id)).toBe("released");
  });

  it("does NOT refund while a sibling run is still in flight", async () => {
    // The regression this whole rewrite exists for: a task gets a fresh
    // thread per dispatch, so one finishing must never refund another's spend.
    const { task, thread } = await chargedTask("sibling", "completed");
    await addThread(task.id, "in_progress");
    await taskBoard.update(task.id, ORG, { status: "todo" }, "system");

    await advanceTasksToReviewOnThreadFinish(
      taskBoard,
      thread.id,
      ORG,
      billing,
    );

    expect(await stateOf(task.id)).toBe("held");
  });

  it("does NOT refund a task that has a pull request, whatever lane it sits in", async () => {
    const { task, thread } = await chargedTask("with-pr", "completed");
    await taskBoard.linkPr({
      taskBoardItemId: task.id,
      organizationId: ORG,
      url: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      repoOwner: "acme",
      repoName: "repo",
      connectionId: null,
    });
    // Even dragged backwards, a delivered PR keeps the charge.
    await taskBoard.update(task.id, ORG, { status: "todo" }, "system");

    await advanceTasksToReviewOnThreadFinish(
      taskBoard,
      thread.id,
      ORG,
      billing,
    );

    expect(await stateOf(task.id)).toBe("held");
  });

  it("does NOT refund once the card reached In Review", async () => {
    const { task, thread } = await chargedTask("in-review", "completed");

    // The advance half itself moves this one to In Review.
    await advanceTasksToReviewOnThreadFinish(
      taskBoard,
      thread.id,
      ORG,
      billing,
    );

    expect((await taskBoard.getById(task.id, ORG))?.status).toBe("in_review");
    expect(await stateOf(task.id)).toBe("held");
  });

  it("leaves user-created tasks alone (never charged, never refunded)", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "mine",
      status: "in_progress",
      by: "user_1",
    });
    await claimTaskExecution(ctx, task, CONFIG); // no-op: not a reports task
    const thread = await addThread(task.id, "completed");
    await taskBoard.update(task.id, ORG, { status: "todo" }, "system");

    await advanceTasksToReviewOnThreadFinish(
      taskBoard,
      thread.id,
      ORG,
      billing,
    );

    expect(await billing.taskClaim(task.id)).toBeNull();
  });

  // Deleting a card must not be a backdoor refund. `task_quota_claims` cascades
  // from `task_board_items`, so a hard delete would turn "delete the card" into
  // a refund: delegate, delete, and the period slot frees up — repeat for
  // unlimited subsidized runs. A reports card is dismissed, not dropped, so the
  // cascade never fires and the charge outlives the card.
  it("deleting a charged task does NOT refund its quota slot", async () => {
    const { task } = await chargedTask("delete-me", "in_progress");
    // The period the charge landed in, read rather than guessed — it depends on
    // the org's billing status.
    const { period_key: periodKey } = await database.db
      .selectFrom("task_quota_claims")
      .select(["period_key"])
      .where("task_board_item_id", "=", task.id)
      .executeTakeFirstOrThrow();
    const before = await billing.countTaskClaims(ORG, periodKey);
    expect(before).toBeGreaterThan(0);

    await taskBoard.delete(task.id, ORG, USER);

    // Off the board...
    expect((await taskBoard.list(ORG)).map((i) => i.id)).not.toContain(task.id);
    // ...and the charge is intact.
    expect(await billing.countTaskClaims(ORG, periodKey)).toBe(before);
    expect(await stateOf(task.id)).toBe("held");
  });
});
