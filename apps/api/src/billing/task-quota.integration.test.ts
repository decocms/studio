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
  commitTaskExecution,
  ensureTaskExecutionAllowed,
  releaseTaskExecution,
  type TaskQuotaConfig,
} from "./task-quota";

// Real-Postgres coverage for the quota ledger: the trial bucket, the
// per-cycle subscribed bucket, the pending-period bucket a just-subscribed
// org lands in, per-task run capping, reports-only scoping, and the atomic
// burst behavior (including the no-billing-row org, whose lock anchor the
// claim self-heals).
const ORG = "org_quota_1";

const CONFIG: TaskQuotaConfig = {
  enforced: true,
  freeTaskExecutions: 2,
  monthlyTaskExecutions: 3,
  maxRunsPerTask: 2,
};

describe("task quota (integration)", () => {
  let database: StudioDatabase;
  let billing: OrganizationBillingStorage;
  let taskBoard: TaskBoardStorage;
  let ctx: StudioContext;

  const makeTask = (by: string, org = ORG) =>
    taskBoard.create({ organizationId: org, title: "t", by });

  const ctxFor = (org: string) =>
    ({
      organization: { id: org, slug: org, name: org },
      storage: { organizationBilling: billing },
    }) as unknown as StudioContext;

  // taskClaim returns null when unclaimed; these read just the tally.
  const runCountOf = async (taskId: string) =>
    (await billing.taskClaim(taskId))?.runCount ?? null;
  const stateOf = async (taskId: string) =>
    (await billing.taskClaim(taskId))?.state ?? null;

  const seedOrg = async (id: string, withBillingRow: boolean) => {
    await database.db
      .insertInto("organization")
      .values({
        id,
        name: id,
        slug: id.replaceAll("_", "-"),
        createdAt: new Date().toISOString(),
      })
      .execute();
    if (withBillingRow) {
      await database.db
        .insertInto("organization_billing")
        .values({ organization_id: id })
        .execute();
    }
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    billing = new OrganizationBillingStorage(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    await seedOrg(ORG, true);
    ctx = ctxFor(ORG);
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

    // The pre-check sees the same answer and never claims.
    await expect(ensureTaskExecutionAllowed(ctx, t3, CONFIG)).rejects.toThrow(
      /^\[SUBSCRIPTION_REQUIRED\]/,
    );
    expect(await billing.countTaskClaims(ORG, "trial")).toBe(2);
  });

  it("a claimed task re-runs free within the per-task cap, then stops", async () => {
    const [claimed] = await database.db
      .selectFrom("task_quota_claims")
      .select(["task_board_item_id", "run_count"])
      .where("organization_id", "=", ORG)
      .limit(1)
      .execute();
    const task = {
      id: claimed!.task_board_item_id,
      createdBy: "system",
      organizationId: ORG,
    };
    expect(claimed!.run_count).toBe(1);

    // Quota is exhausted (2/2) but this task is already claimed: the re-run
    // (review bounce / conflict resolution) is free.
    await claimTaskExecution(ctx, task, CONFIG);
    expect(await runCountOf(task.id)).toBe(2);
    expect(await billing.countTaskClaims(ORG, "trial")).toBe(2);

    // maxRunsPerTask = 2 — one claim must not fund an unbounded
    // re-delegation loop.
    await expect(claimTaskExecution(ctx, task, CONFIG)).rejects.toThrow(
      /^\[SUBSCRIPTION_REQUIRED\].*execution limit/,
    );
    await expect(ensureTaskExecutionAllowed(ctx, task, CONFIG)).rejects.toThrow(
      /execution limit/,
    );
    expect(await runCountOf(task.id)).toBe(2);
  });

  it("user-created tasks are never gated or counted", async () => {
    const userTask = await makeTask("user_1");
    await claimTaskExecution(ctx, userTask, CONFIG); // no throw, no claim
    expect(await runCountOf(userTask.id)).toBeNull();
  });

  it("enforcement off = fully dormant", async () => {
    const t = await makeTask("system");
    await claimTaskExecution(ctx, t, { ...CONFIG, enforced: false });
    expect(await runCountOf(t.id)).toBeNull();
  });

  it("a just-subscribed org gets the monthly limit, not the spent trial bucket", async () => {
    // checkout.session.completed flips status to active WITHOUT a period end;
    // paywalling a customer who just paid would be the worse failure.
    await billing.updateStripeState(ORG, { status: "active" });
    const t = await makeTask("system");
    await claimTaskExecution(ctx, t, CONFIG);
    expect(await billing.countTaskClaims(ORG, "sub:pending")).toBe(1);
  });

  it("the monthly bucket resets when invoice.paid moves the period end", async () => {
    const periodOne = new Date("2026-09-01T00:00:00.000Z");
    await billing.updateStripeState(ORG, {
      status: "active",
      currentPeriodEnd: periodOne,
    });
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
      /^\[SUBSCRIPTION_REQUIRED\]/,
    );
  });

  // A burst is only serialized if the lock has a row to lock, so run it BOTH
  // for a normal org and for one whose billing row was never seeded (a failed
  // creation-time seed) — the claim self-heals that row before locking.
  for (const withBillingRow of [true, false]) {
    it(`a concurrent BURST cannot race past the limit (billing row seeded: ${withBillingRow})`, async () => {
      const org = `org_burst_${withBillingRow}`;
      await seedOrg(org, withBillingRow);
      const burstCtx = ctxFor(org);
      // 10 concurrent claims, limit 2. pg.Pool defaults to max 10 connections
      // and Kysely pins one per transaction, so these ARE 10 concurrent
      // transactions — the FOR UPDATE is genuinely exercised. (A future
      // pool max < 2 would silently serialize them and void this test.)
      const tasks = await Promise.all(
        Array.from({ length: 10 }, () => makeTask("system", org)),
      );
      const results = await Promise.allSettled(
        tasks.map((t) => claimTaskExecution(burstCtx, t, CONFIG)),
      );
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(
        CONFIG.freeTaskExecutions,
      );
      expect(await billing.countTaskClaims(org, "trial")).toBe(
        CONFIG.freeTaskExecutions,
      );
      for (const r of results) {
        if (r.status === "rejected") {
          expect(String(r.reason)).toContain("[SUBSCRIPTION_REQUIRED]");
        }
      }
    });
  }

  it("hold → commit: a dispatch holds the slot, the PR confirms the charge", async () => {
    const org = "org_hold_commit";
    await seedOrg(org, true);
    const ctxHc = ctxFor(org);
    const task = await makeTask("system", org);

    await claimTaskExecution(ctxHc, task, CONFIG);
    expect(await stateOf(task.id)).toBe("held");
    // A hold ALREADY counts: an org can't start more runs than it could finish.
    expect(await billing.countTaskClaims(org, "trial")).toBe(1);

    await commitTaskExecution(billing, task.id);
    expect(await stateOf(task.id)).toBe("committed");
    expect(await billing.countTaskClaims(org, "trial")).toBe(1);

    // Committed is terminal for the charge: a later release must not refund.
    await releaseTaskExecution(billing, task.id);
    expect(await stateOf(task.id)).toBe("committed");
  });

  it("hold → release: a run with no PR gives the slot back", async () => {
    const org = "org_hold_release";
    await seedOrg(org, true);
    const ctxHr = ctxFor(org);
    const [a, b, c] = await Promise.all([
      makeTask("system", org),
      makeTask("system", org),
      makeTask("system", org),
    ]);

    await claimTaskExecution(ctxHr, a!, CONFIG);
    await claimTaskExecution(ctxHr, b!, CONFIG);
    // Trial limit is 2 — the third is refused while both holds stand.
    await expect(claimTaskExecution(ctxHr, c!, CONFIG)).rejects.toThrow(
      /^\[SUBSCRIPTION_REQUIRED\]/,
    );

    // `a`'s run ended without a PR → slot back, and the third task can run.
    await releaseTaskExecution(billing, a!.id);
    expect(await stateOf(a!.id)).toBe("released");
    expect(await billing.countTaskClaims(org, "trial")).toBe(1);
    await claimTaskExecution(ctxHr, c!, CONFIG);
    expect(await billing.countTaskClaims(org, "trial")).toBe(2);
  });

  it("releasing is NOT a free reset — the per-task run cap survives it", async () => {
    const org = "org_release_loop";
    await seedOrg(org, true);
    const ctxRl = ctxFor(org);
    const task = await makeTask("system", org);

    // maxRunsPerTask = 2: dispatch, release, dispatch again → tally is 2.
    await claimTaskExecution(ctxRl, task, CONFIG);
    await releaseTaskExecution(billing, task.id);
    await claimTaskExecution(ctxRl, task, CONFIG);
    expect(await runCountOf(task.id)).toBe(2);

    // A third loop is refused even though the slot was released each time.
    await releaseTaskExecution(billing, task.id);
    await expect(claimTaskExecution(ctxRl, task, CONFIG)).rejects.toThrow(
      /execution limit/,
    );
  });
});
