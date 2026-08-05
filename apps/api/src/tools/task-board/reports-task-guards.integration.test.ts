/**
 * Real-Postgres coverage for the reports-task guards in the board tools:
 * content immutability (UPDATE), delete-dismisses, and the delegation paywall.
 *
 * The paywall test drives `ensureTaskExecutionAllowed` directly with an
 * explicit config, since the tool reads frozen global settings.
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
import {
  claimTaskExecution,
  ensureTaskExecutionAllowed,
} from "../../billing/task-quota";
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

  it("the paywall fires BEFORE the delegation write (no delegated-but-idle task)", async () => {
    const config = {
      enforced: true,
      freeTaskExecutions: 1,
      monthlyTaskExecutions: 1,
      maxRunsPerTask: 5,
    };
    const first = await taskBoard.create({
      organizationId: ORG,
      title: "finding-a",
      by: "system",
    });
    const second = await taskBoard.create({
      organizationId: ORG,
      title: "finding-b",
      by: "system",
    });

    // The org's single trial slot goes to the first task.
    await claimTaskExecution(ctx, first, config);

    // Delegating the second must be refused BEFORE any write: the tool's
    // pre-check is what keeps the card from looking delegated.
    await expect(
      ensureTaskExecutionAllowed(ctx, second, config),
    ).rejects.toThrow(/^\[SUBSCRIPTION_REQUIRED\]/);
    expect((await taskBoard.getById(second.id, ORG))?.assigneeId).toBeNull();
  });

  // Inverts the old assertion: delete used to be refused for a reports task.
  it("deletes a reports task and dismisses its finding", async () => {
    const reportsTask = await taskBoard.create({
      organizationId: ORG,
      title: "finding",
      externalKey: "diag:example.com:lcp",
      by: "system",
    });
    await TASK_BOARD_ITEM_DELETE.handler({ id: reportsTask.id }, ctx);
    expect((await taskBoard.list(ORG)).map((i) => i.id)).not.toContain(
      reportsTask.id,
    );
    expect(await taskBoard.listDismissedFindings(ORG)).toMatchObject([
      { externalKey: "diag:example.com:lcp", dismissedBy: USER },
    ]);
  });

  it("deletes a user task without dismissing anything", async () => {
    const userTask = await taskBoard.create({
      organizationId: ORG,
      title: "mine",
      by: USER,
    });
    const before = await taskBoard.listDismissedFindings(ORG);
    await TASK_BOARD_ITEM_DELETE.handler({ id: userTask.id }, ctx);
    expect(await taskBoard.getById(userTask.id, ORG)).toBeNull();
    // No external_key ⇒ nothing to tombstone.
    expect(await taskBoard.listDismissedFindings(ORG)).toHaveLength(
      before.length,
    );
  });

  it("restores a dismissed finding", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "finding-restorable",
      externalKey: "diag:example.com:ttfb",
      by: "system",
    });
    await TASK_BOARD_ITEM_DELETE.handler({ id: task.id }, ctx);
    expect(
      await taskBoard.dismissedFindingKeys(ORG, ["diag:example.com:ttfb"]),
    ).toEqual(new Set(["diag:example.com:ttfb"]));

    expect(
      await taskBoard.restoreDismissedFindings(ORG, ["diag:example.com:ttfb"]),
    ).toBe(1);
    expect(
      await taskBoard.dismissedFindingKeys(ORG, ["diag:example.com:ttfb"]),
    ).toEqual(new Set());
  });

  it("an empty restore list clears nothing (a filtered-to-zero caller must not wipe the lot)", async () => {
    const task = await taskBoard.create({
      organizationId: ORG,
      title: "finding-kept",
      externalKey: "diag:example.com:cls",
      by: "system",
    });
    await TASK_BOARD_ITEM_DELETE.handler({ id: task.id }, ctx);
    expect(await taskBoard.restoreDismissedFindings(ORG, [])).toBe(0);
    expect(
      await taskBoard.dismissedFindingKeys(ORG, ["diag:example.com:cls"]),
    ).toEqual(new Set(["diag:example.com:cls"]));
  });
});
