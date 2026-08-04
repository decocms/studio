import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioContext } from "../core/studio-context";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { OrganizationBillingStorage } from "../storage/organization-billing";
import { TaskBoardStorage } from "../storage/task-board";
import {
  claimTaskExecution,
  ensureTaskExecutionAllowed,
  type TaskQuotaConfig,
} from "./task-quota";

// Real-Postgres coverage for the quota ledger: the trial bucket, the
// per-cycle subscribed bucket (period_key = current period end), claim
// idempotency per task (re-runs are free), and the reports-only scoping.
const ORG = "org_quota_1";

const CONFIG: TaskQuotaConfig = {
  enforced: true,
  freeTaskExecutions: 2,
  monthlyTaskExecutions: 3,
};

describe("task quota (integration)", () => {
  let database: StudioDatabase;
  let billing: OrganizationBillingStorage;
  let taskBoard: TaskBoardStorage;
  let ctx: StudioContext;

  const makeTask = (by: string) =>
    taskBoard.create({ organizationId: ORG, title: "t", by });

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-quota-1",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await database.db
      .insertInto("organization_billing")
      .values({ organization_id: ORG })
      .execute();
    billing = new OrganizationBillingStorage(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    ctx = {
      organization: { id: ORG, slug: "org-quota-1", name: ORG },
      storage: { organizationBilling: billing },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("trial: allows the free executions, then throws [SUBSCRIPTION_REQUIRED]", async () => {
    const t1 = await makeTask("system");
    const t2 = await makeTask("system");
    const t3 = await makeTask("system");

    await claimTaskExecution(ctx, t1, CONFIG);
    await claimTaskExecution(ctx, t2, CONFIG);
    await expect(claimTaskExecution(ctx, t3, CONFIG)).rejects.toThrow(
      /^\[SUBSCRIPTION_REQUIRED\].*free task executions/,
    );
    expect(await billing.countTaskClaims(ORG, "trial")).toBe(2);

    // The pre-write check sees the same answer and never claims.
    await expect(ensureTaskExecutionAllowed(ctx, t3, CONFIG)).rejects.toThrow(
      /^\[SUBSCRIPTION_REQUIRED\]/,
    );
    expect(await billing.countTaskClaims(ORG, "trial")).toBe(2);
  });

  it("a claimed task re-dispatches free, even over quota (review/conflict re-runs)", async () => {
    const claimed = (await billing.hasTaskClaim("nope")) === false;
    expect(claimed).toBe(true);
    // Quota is exhausted (2/2), but t1's claim already exists:
    const [t1] = await database.db
      .selectFrom("task_quota_claims")
      .select("task_board_item_id")
      .where("organization_id", "=", ORG)
      .limit(1)
      .execute();
    await claimTaskExecution(
      ctx,
      { id: t1!.task_board_item_id, createdBy: "system" },
      CONFIG,
    );
    expect(await billing.countTaskClaims(ORG, "trial")).toBe(2);
  });

  it("user-created tasks are never gated or counted", async () => {
    const userTask = await makeTask("user_1");
    await claimTaskExecution(ctx, userTask, CONFIG); // no throw, no claim
    expect(await billing.hasTaskClaim(userTask.id)).toBe(false);
  });

  it("enforcement off = fully dormant", async () => {
    const t = await makeTask("system");
    await claimTaskExecution(ctx, t, { ...CONFIG, enforced: false });
    expect(await billing.hasTaskClaim(t.id)).toBe(false);
  });

  it("subscribing opens the monthly bucket; a new cycle (invoice.paid) resets it", async () => {
    const periodOne = new Date("2026-09-01T00:00:00.000Z");
    await billing.updateStripeState(ORG, {
      status: "active",
      currentPeriodEnd: periodOne,
    });

    // Monthly limit is 3 — trial claims don't count against it.
    const tasks = await Promise.all([
      makeTask("system"),
      makeTask("system"),
      makeTask("system"),
      makeTask("system"),
    ]);
    await claimTaskExecution(ctx, tasks[0]!, CONFIG);
    await claimTaskExecution(ctx, tasks[1]!, CONFIG);
    await claimTaskExecution(ctx, tasks[2]!, CONFIG);
    await expect(claimTaskExecution(ctx, tasks[3]!, CONFIG)).rejects.toThrow(
      /^\[SUBSCRIPTION_REQUIRED\].*monthly task executions/,
    );
    expect(
      await billing.countTaskClaims(ORG, `sub:${periodOne.toISOString()}`),
    ).toBe(3);

    // invoice.paid moves the period end → fresh bucket, the blocked task runs.
    await billing.updateStripeState(ORG, {
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });
    await claimTaskExecution(ctx, tasks[3]!, CONFIG);
    expect(
      await billing.countTaskClaims(ORG, "sub:2026-10-01T00:00:00.000Z"),
    ).toBe(1);
  });

  it("cancellation closes the gate (trial already burned)", async () => {
    await billing.updateStripeState(ORG, { status: "canceled" });
    const t = await makeTask("system");
    await expect(claimTaskExecution(ctx, t, CONFIG)).rejects.toThrow(
      /^\[SUBSCRIPTION_REQUIRED\].*free task executions/,
    );
  });
});
