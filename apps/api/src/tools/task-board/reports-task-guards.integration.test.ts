/**
 * Real-Postgres coverage for the reports-task guards in the board tools:
 * content immutability (UPDATE/DELETE) and the pre-write paywall on the
 * delegation flip — everything that fires BEFORE any thread/dispatch
 * machinery, so the ctx stub stays small.
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
import { TASK_BOARD_ITEM_DELETE } from "./delete";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

const ORG = "org_guards_1";
const USER = "user_g1";

describe("reports-task guards", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let ctx: StudioContext;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-guards-1", createdAt: now })
      .execute();
    await database.db
      .insertInto("organization_billing")
      .values({ organization_id: ORG })
      .execute();
    // Raw SQL: real Postgres has BOOLEAN emailVerified, which the
    // (PGlite-era) typed table shape disagrees with.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"g1@guards.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    ctx = {
      timings: {
        measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
      },
      auth: { user: { id: USER, email: "g1@guards.test", name: USER } },
      organization: { id: ORG, slug: "org-guards-1", name: ORG },
      storage: {
        taskBoard,
        organizationBilling: new OrganizationBillingStorage(database.db),
      },
      access: {
        granted: () => true,
        check: async () => {},
        grant: () => {},
        setToolName: () => {},
      },
      tracer: {
        startActiveSpan: (
          _name: string,
          _opts: unknown,
          fn: (span: unknown) => unknown,
        ) =>
          fn({
            setStatus: () => {},
            recordException: () => {},
            end: () => {},
          }),
      },
      meter: {
        createHistogram: () => ({ record: () => {} }),
        createCounter: () => ({ add: () => {} }),
      },
      metadata: { requestId: "req_test", timestamp: new Date() },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("rejects content edits on a reports task; user tasks stay editable", async () => {
    const reportsTask = await taskBoard.create({
      organizationId: ORG,
      title: "finding",
      by: "system",
    });
    for (const patch of [
      { title: "renamed" },
      { description: "rewritten" },
      { priority: "high" as const },
    ]) {
      await expect(
        TASK_BOARD_ITEM_UPDATE.handler({ id: reportsTask.id, ...patch }, ctx),
      ).rejects.toThrow(/generated from your report/);
    }
    // Board interactions stay free: status/drag and due date.
    const moved = await TASK_BOARD_ITEM_UPDATE.handler(
      { id: reportsTask.id, status: "todo", sortOrder: 1 },
      ctx,
    );
    expect(moved.item.status).toBe("todo");

    const userTask = await taskBoard.create({
      organizationId: ORG,
      title: "mine",
      by: USER,
    });
    const renamed = await TASK_BOARD_ITEM_UPDATE.handler(
      { id: userTask.id, title: "renamed" },
      ctx,
    );
    expect(renamed.item.title).toBe("renamed");
  });

  it("rejects deleting a reports task; user tasks delete fine", async () => {
    const reportsTask = await taskBoard.create({
      organizationId: ORG,
      title: "finding",
      by: "system",
    });
    await expect(
      TASK_BOARD_ITEM_DELETE.handler({ id: reportsTask.id }, ctx),
    ).rejects.toThrow(/can't be deleted/);
    expect(await taskBoard.getById(reportsTask.id, ORG)).not.toBeNull();

    const userTask = await taskBoard.create({
      organizationId: ORG,
      title: "mine",
      by: USER,
    });
    await TASK_BOARD_ITEM_DELETE.handler({ id: userTask.id }, ctx);
    expect(await taskBoard.getById(userTask.id, ORG)).toBeNull();
  });
});
